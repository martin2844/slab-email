import { DatabaseService } from './database.js';

const databasePath = process.env.DATABASE_PATH?.trim() || '/data/slab-email.db';
const database = new DatabaseService(databasePath);
database.close();
