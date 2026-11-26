CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, salt TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_password_email ON accounts(email) WHERE password_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS identities (
 provider TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL,
 PRIMARY KEY(provider,subject)
);
CREATE TABLE IF NOT EXISTS account_sessions (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires);
CREATE TABLE IF NOT EXISTS oauth_states (
 state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, nonce TEXT NOT NULL,
 verifier TEXT NOT NULL, browser_hash TEXT NOT NULL, device_id TEXT, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_devices (
 id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, label TEXT NOT NULL,
 account_id TEXT, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_limits (
 bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL
);
