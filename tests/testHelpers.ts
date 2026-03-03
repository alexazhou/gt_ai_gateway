/**
 * Test Helpers
 * Exposes database helpers for test files that need direct DB access
 */

import dbHelper from "./helpers/dbHelper";

export default {
    query: dbHelper.query,
    execute: dbHelper.execute,
    truncateDatabase: dbHelper.truncate,
};
