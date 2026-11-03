import postgres from "postgres";

const POSTGRES_URL = process.env.MY_APP_POSTGRES_URL;
export const POSTGRES_SCHEMA = process.env.MY_APP_POSTGRES_SCHEMA || "public";

if (!POSTGRES_URL) {
    throw new Error("MY_APP_POSTGRES_URL is not defined; run mise or source .envrc");
}

export const sql = postgres(POSTGRES_URL, {
    idle_timeout: 1,
    connection: {
        search_path: POSTGRES_SCHEMA,
    },
});
