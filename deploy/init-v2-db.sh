#!/bin/sh
set -eu
# Read only explicitly mounted role files, keeping values out of argv/output.
if [ -n "${HDD_V2_API_PASSWORD_FILE:-}" ]; then HDD_V2_API_PASSWORD=$(cat "$HDD_V2_API_PASSWORD_FILE"); export HDD_V2_API_PASSWORD; fi
if [ -n "${HDD_V2_WORKER_PASSWORD_FILE:-}" ]; then HDD_V2_WORKER_PASSWORD=$(cat "$HDD_V2_WORKER_PASSWORD_FILE"); export HDD_V2_WORKER_PASSWORD; fi
if [ -n "${HDD_V2_MIGRATOR_PASSWORD_FILE:-}" ]; then HDD_V2_MIGRATOR_PASSWORD=$(cat "$HDD_V2_MIGRATOR_PASSWORD_FILE"); export HDD_V2_MIGRATOR_PASSWORD; fi
# Runs only during initdb of a NEW task-owned volume. No runtime role owns DDL.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv instance HDD_V2_DB_INSTANCE
\getenv api_password HDD_V2_API_PASSWORD
\getenv worker_password HDD_V2_WORKER_PASSWORD
\getenv migrator_password HDD_V2_MIGRATOR_PASSWORD
REVOKE ALL ON DATABASE hexdailydata_v2 FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE hdd_v2_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'migrator_password';
CREATE ROLE hdd_v2_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'worker_password';
CREATE ROLE hdd_v2_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'api_password';
GRANT CONNECT ON DATABASE hexdailydata_v2 TO hdd_v2_migrator,hdd_v2_worker,hdd_v2_api;
GRANT CREATE ON DATABASE hexdailydata_v2 TO hdd_v2_migrator;
CREATE SCHEMA hdd_identity;
REVOKE ALL ON SCHEMA hdd_identity FROM PUBLIC;
CREATE TABLE hdd_identity.instance(singleton boolean PRIMARY KEY CHECK(singleton),instance uuid NOT NULL);
INSERT INTO hdd_identity.instance VALUES(true,:'instance');
GRANT USAGE ON SCHEMA hdd_identity TO hdd_v2_migrator,hdd_v2_worker,hdd_v2_api;
GRANT SELECT ON hdd_identity.instance TO hdd_v2_migrator,hdd_v2_worker,hdd_v2_api;
ALTER ROLE hdd_v2_api SET default_transaction_read_only=on;
SQL
