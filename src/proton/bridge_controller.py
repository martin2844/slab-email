#!/usr/bin/env python3
"""Private JSON-lines controller for Proton Bridge's official CLI binary.

The process owns Bridge's pseudo-terminal. It never forwards CLI output or
credentials to stdout; stdout contains only bounded protocol responses.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any


ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
PROMPT_RE = re.compile(r">>>\s*$", re.MULTILINE)
ALREADY_LOGGED_IN_RE = re.compile(
    r"Cannot login:\s*the user is already logged in", re.IGNORECASE
)
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+$")
MAX_BUFFER = 1024 * 1024
CHALLENGE_TTL_SECONDS = 10 * 60
PROMPT_QUIET_SECONDS = 0.05
PROMPT_SETTLE_LIMIT_SECONDS = 0.25


class ControllerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class BridgeController:
    def __init__(self, bridge_binary: str, data_directory: str):
        self.bridge_binary = bridge_binary
        self.root = Path(data_directory)
        self.master_fd: int | None = None
        self.child_pid: int | None = None
        self.buffer = ""
        self.pending_command: str | None = None
        self.pending: dict[str, Any] | None = None
        self.environment = self._prepare_environment()

    def start(self) -> None:
        self._ensure_keychain()
        self._spawn_bridge()
        self._expect([PROMPT_RE], 45)
        self._set_privacy_defaults()

    def stop(self) -> None:
        if self.child_pid is None:
            return
        try:
            os.kill(self.child_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                pid, _ = os.waitpid(self.child_pid, os.WNOHANG)
            except ChildProcessError:
                pid = self.child_pid
            if pid:
                break
            time.sleep(0.05)
        else:
            try:
                os.kill(self.child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
        self.master_fd = None
        self.child_pid = None
        self.buffer = ""
        self.pending_command = None
        self.pending = None

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        action = request.get("action")
        if action == "status":
            return self._status()
        if action == "connect":
            return self._connect(request)
        if action == "challenge":
            return self._challenge(request)
        if action == "abort":
            return self._abort(request)
        if action == "remove":
            return self._remove(request)
        if action == "addresses":
            return self._addresses(request)
        raise ControllerError("INVALID_ACTION", "Unsupported Proton Bridge controller action.")

    def _prepare_environment(self) -> dict[str, str]:
        home = self.root / "home"
        config = self.root / "config"
        cache = self.root / "cache"
        data = self.root / "data"
        gnupg = self.root / "gnupg"
        password_store = self.root / "password-store"
        for directory in (self.root, home, config, cache, data, gnupg, password_store):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
        environment = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
            "TERM": os.environ.get("TERM", "xterm-256color"),
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(config),
            "XDG_CACHE_HOME": str(cache),
            "XDG_DATA_HOME": str(data),
            "GNUPGHOME": str(gnupg),
            "PASSWORD_STORE_DIR": str(password_store),
            "NO_COLOR": "1",
        }
        return environment

    def _ensure_keychain(self) -> None:
        if not shutil.which("gpg", path=self.environment["PATH"]) or not shutil.which(
            "pass", path=self.environment["PATH"]
        ):
            raise ControllerError(
                "KEYCHAIN_UNAVAILABLE",
                "Managed Proton Bridge requires gpg and pass in the slab-email image.",
            )
        gpg_id = Path(self.environment["PASSWORD_STORE_DIR"]) / ".gpg-id"
        if gpg_id.exists() and gpg_id.read_text(encoding="utf-8").strip():
            return
        identity = "Slab Proton Bridge <bridge@slab.local>"
        result = subprocess.run(
            [
                "gpg",
                "--batch",
                "--pinentry-mode",
                "loopback",
                "--passphrase",
                "",
                "--quick-gen-key",
                identity,
                "default",
                "default",
                "never",
            ],
            env=self.environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
            check=False,
        )
        if result.returncode != 0:
            raise ControllerError("KEYCHAIN_INITIALIZATION_FAILED", "Could not initialize the Bridge keychain.")
        listed = subprocess.run(
            ["gpg", "--batch", "--with-colons", "--list-secret-keys", identity],
            env=self.environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
            check=False,
        )
        fingerprint = next(
            (line.split(":")[9] for line in listed.stdout.splitlines() if line.startswith("fpr:")),
            "",
        )
        if not fingerprint:
            raise ControllerError("KEYCHAIN_INITIALIZATION_FAILED", "Could not initialize the Bridge keychain.")
        initialized = subprocess.run(
            ["pass", "init", fingerprint],
            env=self.environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
        if initialized.returncode != 0:
            raise ControllerError("KEYCHAIN_INITIALIZATION_FAILED", "Could not initialize the Bridge keychain.")

    def _spawn_bridge(self) -> None:
        if not os.path.isfile(self.bridge_binary) or not os.access(self.bridge_binary, os.X_OK):
            raise ControllerError("BRIDGE_BINARY_UNAVAILABLE", "Managed Proton Bridge binary is unavailable.")
        child_pid, master_fd = os.forkpty()
        if child_pid == 0:
            os.execve(
                self.bridge_binary,
                [self.bridge_binary, "--cli", "--log-level", "warn"],
                self.environment,
            )
        self.child_pid = child_pid
        self.master_fd = master_fd
        os.set_blocking(master_fd, False)

    def _restart_bridge(self) -> None:
        self.stop()
        self._spawn_bridge()
        self._expect([PROMPT_RE], 45)
        self._set_privacy_defaults()

    def _set_privacy_defaults(self) -> None:
        self._send_command("telemetry disable")
        output, index = self._expect(
            [re.compile(r"Do you want to disable usage diagnostics collection", re.I), PROMPT_RE],
            15,
        )
        if index == 0:
            self._send_line("yes")
            self._expect([PROMPT_RE], 15)
        self._send_command("updates autoupdates disable")
        _, index = self._expect(
            [re.compile(r"Are you sure you want to stop bridge from doing this", re.I), PROMPT_RE],
            15,
        )
        if index == 0:
            self._send_line("yes")
            self._expect([PROMPT_RE], 15)

    def _status(self) -> dict[str, Any]:
        if self.pending:
            if self.pending["expiresAtMonotonic"] <= time.monotonic():
                self._restart_bridge()
            else:
                return {"state": "ready", "accounts": [], "message": "Account setup is waiting for input."}
        self._send_command("list")
        output, _ = self._expect([PROMPT_RE], 15)
        accounts = []
        for match in re.finditer(
            r"^\s*(?:>>>\s*)*\d+\s*:\s+(\S+)\s+\((connected|signed out|locked)\s*,",
            output,
            re.MULTILINE | re.IGNORECASE,
        ):
            accounts.append({"emailAddress": match.group(1), "state": match.group(2).lower()})
        return {"state": "ready", "accounts": accounts}

    def _connect(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.pending:
            raise ControllerError("SETUP_IN_PROGRESS", "Another Proton Bridge setup is already in progress.")
        email = self._safe_text(request.get("emailAddress"), "emailAddress", 320)
        password = self._safe_text(request.get("password"), "password", 4096)
        if not EMAIL_RE.match(email):
            raise ControllerError("INVALID_INPUT", "A valid Proton email address is required.")
        self._send_command("login")
        self._expect([re.compile(r"Username:\s*$", re.MULTILINE)], 15)
        self._send_line(email)
        self._expect([re.compile(r"Password:\s*$", re.MULTILINE)], 15)
        self._send_line(password)
        password = ""
        return self._advance_login(email)

    def _challenge(self, request: dict[str, Any]) -> dict[str, Any]:
        pending = self.pending
        challenge_id = self._safe_text(request.get("challengeId"), "challengeId", 100)
        if not pending or pending["id"] != challenge_id:
            raise ControllerError("STATE_INVALID", "Proton Bridge setup session is not active.")
        if pending["expiresAtMonotonic"] <= time.monotonic():
            self._restart_bridge()
            raise ControllerError("STATE_EXPIRED", "Proton Bridge setup session expired.")
        value = self._safe_text(request.get("value", ""), "value", 4096, allow_empty=True)
        if pending["type"] != "human_verification" and not value:
            raise ControllerError("INVALID_INPUT", "A challenge value is required.")
        self._send_line(value)
        value = ""
        return self._advance_login(pending["emailAddress"])

    def _abort(self, request: dict[str, Any]) -> dict[str, Any]:
        challenge_id = self._safe_text(request.get("challengeId"), "challengeId", 100)
        if self.pending and self.pending["id"] == challenge_id:
            self._restart_bridge()
        self.pending = None
        return {"state": "aborted"}

    def _remove(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.pending:
            raise ControllerError("SETUP_IN_PROGRESS", "Account setup must finish before removing an account.")
        email = self._safe_text(request.get("emailAddress"), "emailAddress", 320)
        if not EMAIL_RE.match(email):
            raise ControllerError("INVALID_INPUT", "A valid Proton email address is required.")
        self._send_command(f"delete {email}")
        _, index = self._expect(
            [re.compile(r"Are you sure you want to.*remove account", re.I), PROMPT_RE],
            15,
        )
        if index == 0:
            self._send_line("yes")
            self._expect([PROMPT_RE], 30)
        return {"state": "removed", "emailAddress": email}

    def _addresses(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.pending:
            raise ControllerError("SETUP_IN_PROGRESS", "Account setup must finish before discovering addresses.")
        email = self._safe_text(request.get("emailAddress"), "emailAddress", 320)
        self._send_command("list")
        output, _ = self._expect([PROMPT_RE], 15)
        account = self._bridge_account(output, email)
        if account is None:
            raise ControllerError("ACCOUNT_NOT_FOUND", "Managed Proton account was not found in Bridge.")
        if account.group("state").lower() != "connected":
            raise ControllerError("PROVIDER_UNAVAILABLE", "Managed Proton account is not connected.")

        mode = account.group("mode").lower()
        if mode == "combined" and request.get("enableSplit") is True:
            self._send_command(f"change mode {account.group('index')}")
            _, confirmation = self._expect(
                [re.compile(r"Are you sure you want to change the mode", re.IGNORECASE), PROMPT_RE],
                30,
            )
            if confirmation == 0:
                self._send_line("yes")
                self._expect([PROMPT_RE], 120)
            self._send_command("list")
            refreshed, _ = self._expect([PROMPT_RE], 15)
            account = self._bridge_account(refreshed, email)
            if account is None or account.group("mode").lower() != "split":
                raise ControllerError(
                    "CONFIGURATION_UNAVAILABLE",
                    "Bridge did not enable split-address mode.",
                )
            mode = account.group("mode").lower()

        self._send_command(f"info {email}")
        info, _ = self._expect([PROMPT_RE], 60)
        mailboxes = self._parse_mailboxes(info)
        if not mailboxes:
            raise ControllerError(
                "CONFIGURATION_UNAVAILABLE",
                "Bridge sender addresses could not be read.",
            )
        return {"state": "addresses", "mode": mode, "mailboxes": mailboxes}

    @staticmethod
    def _bridge_account(output: str, email: str) -> re.Match[str] | None:
        rows = list(re.finditer(
            r"^\s*(?:>>>\s*)*(?P<index>\d+)\s*:\s+(?P<email>\S+)\s+\((?P<state>connected|signed out|locked)\s*,\s*(?P<mode>combined|split)(?:\s+mode)?\s*\)",
            output,
            re.MULTILINE | re.IGNORECASE,
        ))
        requested = email.lower()
        requested_username = requested.split("@", 1)[0]
        matched = next(
            (row for row in rows if row.group("email").lower() == requested),
            None,
        )
        username_matches = [
            row for row in rows if row.group("email").lower() == requested_username
        ]
        if matched is None and len(username_matches) == 1:
            matched = username_matches[0]
        # Proton's list command renders the account login username, which can
        # differ from every mailbox address (for example `clasificar` versus
        # `clasificar@proton.me`). Its own `info` command also selects the sole
        # account regardless of the supplied name, so mirror that behavior.
        return matched or (rows[0] if len(rows) == 1 else None)

    def _advance_login(self, email: str) -> dict[str, Any]:
        patterns = [
            re.compile(r"Two factor code:\s*$", re.MULTILINE | re.IGNORECASE),
            re.compile(r"Mailbox password:\s*$", re.MULTILINE | re.IGNORECASE),
            re.compile(r"Human Verification requested\.", re.IGNORECASE),
            re.compile(r"Do you want to use a security key", re.IGNORECASE),
            re.compile(r"Account\s+\S+\s+was added successfully\.", re.IGNORECASE),
            ALREADY_LOGGED_IN_RE,
            re.compile(r"Cannot login:", re.IGNORECASE),
            re.compile(r"Security key authentication required", re.IGNORECASE),
            PROMPT_RE,
        ]
        output, index = self._expect(patterns, 90)
        if index == 0:
            return self._new_challenge(email, "two_factor")
        if index == 1:
            return self._new_challenge(email, "mailbox_password")
        if index == 2:
            more, _ = self._expect(
                [re.compile(r"https://[^\s\x1b]+", re.IGNORECASE)],
                15,
            )
            combined = output + more
            urls = re.findall(r"https://[^\s\x1b]+", combined)
            return self._new_challenge(
                email,
                "human_verification",
                verification_url=urls[-1].rstrip(".,") if urls else None,
            )
        if index == 3:
            self._send_line("no")
            return self._advance_login(email)
        if index == 4:
            self._expect([PROMPT_RE], 30)
            self.pending = None
            return {"state": "connected", "mailbox": self._mailbox_info(email)}
        if index == 5:
            # Proton has authenticated the credentials and identified an
            # account that this Bridge process already owns. Treat that as an
            # idempotent connect and recover its generated mailbox settings;
            # reporting AUTH_FAILED here is both false and prevents an
            # existing Bridge account from being adopted by slab-email.
            self._expect([PROMPT_RE], 15)
            self.pending = None
            return {"state": "connected", "mailbox": self._mailbox_info(email)}
        if index in (6, 7):
            self._expect([PROMPT_RE], 15)
            raise ControllerError("AUTH_FAILED", "Proton rejected the account login.")
        raise ControllerError("AUTH_FAILED", "Proton Bridge login did not complete.")

    def _new_challenge(
        self, email: str, challenge_type: str, verification_url: str | None = None
    ) -> dict[str, Any]:
        challenge_id = str(uuid.uuid4())
        expires_epoch = time.time() + CHALLENGE_TTL_SECONDS
        self.pending = {
            "id": challenge_id,
            "type": challenge_type,
            "emailAddress": email,
            "expiresAtMonotonic": time.monotonic() + CHALLENGE_TTL_SECONDS,
        }
        result: dict[str, Any] = {
            "state": "challenge_required",
            "challengeId": challenge_id,
            "challengeType": challenge_type,
            "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_epoch)),
        }
        if verification_url:
            result["verificationUrl"] = verification_url
        return result

    def _mailbox_info(self, email: str) -> dict[str, Any]:
        self._send_command(f"info {email}")
        output, _ = self._expect([PROMPT_RE], 30)
        normalized = self._clean(output)
        mailboxes = self._parse_mailboxes(normalized)
        mailbox = next(
            (entry for entry in mailboxes if entry["emailAddress"].lower() == email.lower()),
            mailboxes[0] if len(mailboxes) == 1 else None,
        )
        if mailbox is None:
            raise ControllerError(
                "CONFIGURATION_UNAVAILABLE",
                "Bridge connected the account but mailbox configuration could not be read.",
            )
        return mailbox

    def _parse_mailboxes(self, output: str) -> list[dict[str, Any]]:
        pattern = re.compile(
            r"Configuration for\s+(?P<email>\S+).*?"
            r"IMAP Settings\s+Address:\s*(?P<imap_host>\S+)\s+"
            r"IMAP port:\s*(?P<imap_port>\d+)\s+Username:\s*(?P<imap_user>\S+)\s+"
            r"Password:\s*(?P<imap_password>\S+)\s+Security:\s*(?P<imap_security>\S+).*?"
            r"SMTP Settings\s+Address:\s*(?P<smtp_host>\S+)\s+"
            r"SMTP port:\s*(?P<smtp_port>\d+)\s+Username:\s*(?P<smtp_user>\S+)\s+"
            r"Password:\s*(?P<smtp_password>\S+)\s+Security:\s*(?P<smtp_security>\S+)",
            re.DOTALL | re.IGNORECASE,
        )
        mailboxes = []
        for match in pattern.finditer(self._clean(output)):
            if match.group("imap_password") != match.group("smtp_password"):
                continue
            mailboxes.append({
                "emailAddress": match.group("email"),
                "imapHost": match.group("imap_host"),
                "imapPort": int(match.group("imap_port")),
                "imapTlsMode": self._tls_mode(match.group("imap_security")),
                "smtpHost": match.group("smtp_host"),
                "smtpPort": int(match.group("smtp_port")),
                "smtpTlsMode": self._tls_mode(match.group("smtp_security")),
                "username": match.group("imap_user"),
                "bridgePassword": match.group("imap_password"),
            })
        return mailboxes

    @staticmethod
    def _tls_mode(value: str) -> str:
        return "ssl" if value.upper() == "SSL" else "starttls"

    @staticmethod
    def _safe_text(value: Any, field: str, maximum: int, allow_empty: bool = False) -> str:
        if not isinstance(value, str) or len(value) > maximum or "\n" in value or "\r" in value:
            raise ControllerError("INVALID_INPUT", f"Invalid {field}.")
        if not allow_empty and not value:
            raise ControllerError("INVALID_INPUT", f"Invalid {field}.")
        return value

    def _send_line(self, value: str) -> None:
        if self.master_fd is None:
            raise ControllerError("BRIDGE_STOPPED", "Managed Proton Bridge is not running.")
        os.write(self.master_fd, value.encode("utf-8") + b"\n")

    def _send_command(self, value: str) -> None:
        if self.pending_command is not None:
            raise ControllerError(
                "STATE_INVALID",
                "Managed Proton Bridge is still waiting for its previous command.",
            )
        self.pending_command = value
        self._send_line(value)

    def _expect(self, patterns: list[re.Pattern[str]], timeout: float) -> tuple[str, int]:
        deadline = time.monotonic() + timeout
        while True:
            clean = self._clean(self.buffer)
            found: list[tuple[re.Match[str], int]] = []
            if self.pending_command is not None:
                # The PTY echoes each top-level command. Do not accept a prompt
                # as that command's response until its echo is observed: ishell
                # can redraw an old idle prompt hundreds of milliseconds later,
                # after the command was already written. Time-based draining
                # cannot make that race deterministic.
                command_echo = re.search(
                    rf"(?:^|\n)(?:>>>[ \t]*)?{re.escape(self.pending_command)}[ \t]*\n",
                    clean,
                    re.MULTILINE,
                )
                if command_echo is not None:
                    self.buffer = clean[command_echo.end() :]
                    self.pending_command = None
                    continue
            else:
                matches = [(pattern.search(clean), index) for index, pattern in enumerate(patterns)]
                found = [(match, index) for match, index in matches if match]
            if found:
                match, index = min(found, key=lambda item: item[0].start())
                if patterns[index].pattern == PROMPT_RE.pattern:
                    self._settle_prompt_redraws(deadline)
                    clean = self._clean(self.buffer)
                    prompts = list(PROMPT_RE.finditer(clean))
                    if not prompts:
                        continue
                    match = prompts[-1]
                output = clean[: match.end()]
                # Preserve bytes already received after the matched prompt. Bridge
                # commonly writes a success line and the next CLI prompt in one
                # PTY read; discarding that tail would leave the controller waiting
                # forever for a prompt that already arrived.
                self.buffer = clean[match.end() :]
                return output, index
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ControllerError("BRIDGE_TIMEOUT", "Managed Proton Bridge did not respond in time.")
            if self.master_fd is None:
                raise ControllerError("BRIDGE_STOPPED", "Managed Proton Bridge is not running.")
            readable, _, _ = select.select([self.master_fd], [], [], min(remaining, 1.0))
            if not readable:
                continue
            try:
                chunk = os.read(self.master_fd, 16_384)
            except BlockingIOError:
                continue
            except OSError as error:
                raise ControllerError("BRIDGE_STOPPED", "Managed Proton Bridge stopped unexpectedly.") from error
            if not chunk:
                raise ControllerError("BRIDGE_STOPPED", "Managed Proton Bridge stopped unexpectedly.")
            self.buffer = (self.buffer + chunk.decode("utf-8", errors="replace"))[-MAX_BUFFER:]

    def _settle_prompt_redraws(self, request_deadline: float) -> None:
        """Consume delayed ishell prompt redraws before the next command.

        Bridge's CLI can repaint the same prompt shortly after it first becomes
        visible. Leaving that second prompt in the PTY makes the next request
        look complete before Bridge has processed it, shifting every later
        response by one command.
        """
        if self.master_fd is None:
            return
        hard_deadline = min(
            request_deadline,
            time.monotonic() + PROMPT_SETTLE_LIMIT_SECONDS,
        )
        quiet_deadline = min(
            hard_deadline,
            time.monotonic() + PROMPT_QUIET_SECONDS,
        )
        while time.monotonic() < hard_deadline:
            wait_for = min(quiet_deadline, hard_deadline) - time.monotonic()
            if wait_for <= 0:
                return
            readable, _, _ = select.select([self.master_fd], [], [], wait_for)
            if not readable:
                return
            try:
                chunk = os.read(self.master_fd, 16_384)
            except BlockingIOError:
                continue
            except OSError as error:
                raise ControllerError(
                    "BRIDGE_STOPPED",
                    "Managed Proton Bridge stopped unexpectedly.",
                ) from error
            if not chunk:
                raise ControllerError(
                    "BRIDGE_STOPPED",
                    "Managed Proton Bridge stopped unexpectedly.",
                )
            self.buffer = (
                self.buffer + chunk.decode("utf-8", errors="replace")
            )[-MAX_BUFFER:]
            quiet_deadline = min(
                hard_deadline,
                time.monotonic() + PROMPT_QUIET_SECONDS,
            )

    @staticmethod
    def _clean(value: str) -> str:
        # ishell redraws its prompt with carriage returns and backspaces. Keep
        # those terminal cursor controls out of the protocol parser so the
        # real Bridge prompt is matched the same way as a plain-text prompt.
        return ANSI_RE.sub("", value).replace("\r", "\n").replace("\x08", "")


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--bridge", required=True)
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    controller = BridgeController(args.bridge, args.data_dir)

    def shutdown(_signum: int, _frame: Any) -> None:
        controller.stop()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        controller.start()
        emit({"id": None, "ok": True, "event": "ready"})
    except ControllerError as error:
        emit({"id": None, "ok": False, "event": "startup_failed", "error": {"code": error.code, "message": str(error)}})
        return 1

    try:
        for line in sys.stdin:
            request_id: str | None = None
            try:
                request = json.loads(line)
                request_id = request.get("id") if isinstance(request, dict) else None
                if not request_id:
                    raise ControllerError("INVALID_REQUEST", "Controller request ID is required.")
                result = controller.handle(request)
                emit({"id": request_id, "ok": True, "result": result})
            except ControllerError as error:
                emit({"id": request_id, "ok": False, "error": {"code": error.code, "message": str(error)}})
            except Exception:
                emit({"id": request_id, "ok": False, "error": {"code": "INTERNAL_ERROR", "message": "Managed Proton Bridge request failed."}})
    finally:
        controller.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
