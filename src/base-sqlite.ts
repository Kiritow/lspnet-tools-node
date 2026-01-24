import { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Logger } from "./base-log";
import assert from "assert";

export class BaseSQLite {
    private db: DatabaseSync;
    private logger?: Logger;

    constructor(filename: string, logger?: Logger) {
        this.db = new DatabaseSync(filename);
        this.logger = logger;
    }

    _run(sql: string, params?: SQLInputValue[]) {
        this.logger?.debug(sql, params);
        const stmt = this.db.prepare(sql);
        const result = stmt.run(...(params ?? []));
        const lastID = result.lastInsertRowid;
        const changes = result.changes;
        assert(typeof lastID === "number", "BigInt lastID not supported");
        assert(typeof changes === "number", "BigInt changes not supported");
        return { lastID, changes };
    }

    // UPDATE, DELETE returns the number of rows changed
    run(sql: string, params?: SQLInputValue[]) {
        return this._run(sql, params).changes;
    }

    query(sql: string, params?: SQLInputValue[]) {
        this.logger?.debug(sql, params);
        const stmt = this.db.prepare(sql);
        const result = stmt.all(...(params ?? []));
        return result;
    }

    insert(table: string, data: Record<string, SQLInputValue>) {
        const keys = Object.keys(data);
        const sqlValues = new Array(keys.length).fill("?").join(",");

        const sql = `INSERT INTO ${table}(${keys.join(",")}) VALUES(${sqlValues})`;
        const params = keys.map((key) => data[key]);

        return this._run(sql, params).lastID;
    }

    insertIgnore(table: string, data: Record<string, SQLInputValue>) {
        const keys = Object.keys(data);
        const sqlValues = new Array(keys.length).fill("?").join(",");

        const sql = `INSERT INTO ${table}(${keys.join(",")}) VALUES(${sqlValues}) ON CONFLICT DO NOTHING`;
        const params = keys.map((key) => data[key]);

        return this._run(sql, params).lastID;
    }

    upsert(
        table: string,
        data: Record<string, SQLInputValue>,
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

        return this._run(sql, params).lastID;
    }
}
