import sqlite3 from "sqlite3";
import { Logger } from "./base-log";

export class BaseSQLite {
    private db: sqlite3.Database;
    private logger?: Logger;

    constructor(filename: string, logger?: Logger) {
        this.db = new sqlite3.Database(filename);
        this.logger = logger;
    }

    async _run(sql: string, params?: unknown) {
        return new Promise<{ lastID: number; changes: number }>(
            (resolve, reject) => {
                this.logger?.debug(sql, params);
                this.db.run(sql, params, function (this, err) {
                    if (err !== null) {
                        reject(err);
                    } else {
                        resolve({
                            lastID: this.lastID,
                            changes: this.changes,
                        });
                    }
                });
            }
        );
    }

    // UPDATE, DELETE returns the number of rows changed
    async run(sql: string, params?: unknown) {
        return (await this._run(sql, params)).changes;
    }

    async query(sql: string, params?: unknown) {
        return new Promise<unknown[]>((resolve, reject) => {
            this.logger?.debug(sql, params);
            this.db.all<unknown>(sql, params, function (this, err, rows) {
                if (err !== null) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async insert(table: string, data: Record<string, unknown>) {
        const keys = Object.keys(data);
        const sqlValues = new Array(keys.length).fill("?").join(",");

        const sql = `INSERT INTO ${table}(${keys.join(",")}) VALUES(${sqlValues})`;
        const params = keys.map((key) => data[key]);

        return (await this._run(sql, params)).lastID;
    }

    async insertIgnore(table: string, data: Record<string, unknown>) {
        const keys = Object.keys(data);
        const sqlValues = new Array(keys.length).fill("?").join(",");

        const sql = `INSERT INTO ${table}(${keys.join(",")}) VALUES(${sqlValues}) ON CONFLICT DO NOTHING`;
        const params = keys.map((key) => data[key]);

        return (await this._run(sql, params)).lastID;
    }

    async upsert(
        table: string,
        data: Record<string, unknown>,
        upsertKeys: string[],
        updateTimeFieldName?: string
    ) {
        const keys = Object.keys(data);
        const sqlValuesPart = new Array(keys.length).fill("?").join(",");

        const sqlUpdatePart = upsertKeys.map((key) => `${key}=?`);
        if (updateTimeFieldName !== undefined) {
            sqlUpdatePart.push(`${updateTimeFieldName}=NOW()`);
        }
        const sqlUpdate = sqlUpdatePart.join(",");

        const sql = `INSERT INTO ${table}(${keys.join(",")}) VALUES(${sqlValuesPart}) ON CONFLICT DO UPDATE SET ${sqlUpdate}`;
        const params = keys
            .map((key) => data[key])
            .concat(upsertKeys.map((key) => data[key]));

        return (await this._run(sql, params)).lastID;
    }
}
