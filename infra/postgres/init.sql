CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT NOT NULL,
  bot_role TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  resource TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp DESC);

CREATE TABLE IF NOT EXISTS user_credentials (
  username TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  bot_role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_user_credentials_bot_role CHECK (bot_role IN ('HR_BOT', 'MARKETING_BOT'))
);

INSERT INTO user_credentials (username, user_id, bot_role, password_hash, is_active) VALUES
  (
    'hr_bot_user',
    'user-001',
    'HR_BOT',
    'scrypt$efe93778fe560f7d7c0dff760bd3dcac$86ac0b1e2998912126e5ecd6630d8e48aae5278d5dd1742b321d2e7b7d67df607ee5098a763d4a9ea4df93e1067e624a95627d8c8b8bc5f05cdc03d785bead94',
    TRUE
  ),
  (
    'marketing_bot_user',
    'user-002',
    'MARKETING_BOT',
    'scrypt$9d731aeaa5bb1bc4ba061c6128bd8e08$a524ab931131b1b4fb4be528e2f9fc2bdf0849142cb0c701e020b13f13d17430f84e1c7a399ffc98daccb7f64cb210743943dbf9dbe47d77168ea23434178074',
    TRUE
  )
ON CONFLICT (username) DO UPDATE
SET
  user_id = EXCLUDED.user_id,
  bot_role = EXCLUDED.bot_role,
  password_hash = EXCLUDED.password_hash,
  is_active = EXCLUDED.is_active;

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dept TEXT NOT NULL,
  level TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_summary (
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  month DATE NOT NULL,
  total_comp NUMERIC(12, 2) NOT NULL,
  PRIMARY KEY (employee_id, month)
);

CREATE TABLE IF NOT EXISTS payroll_line_items (
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  month DATE NOT NULL,
  bank_account TEXT NOT NULL,
  tax_id TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  PRIMARY KEY (employee_id, month, bank_account, tax_id, amount)
);

INSERT INTO employees (id, name, dept, level) VALUES
  (1, 'Avery Lee', 'HR', 'L4'),
  (2, 'Jordan Kim', 'Finance', 'L3'),
  (3, 'Taylor Singh', 'Engineering', 'L5')
ON CONFLICT (id) DO NOTHING;

INSERT INTO payroll_summary (employee_id, month, total_comp) VALUES
  (1, DATE '2026-01-01', 11250.00),
  (2, DATE '2026-01-01', 9750.00),
  (3, DATE '2026-01-01', 13200.00)
ON CONFLICT (employee_id, month) DO NOTHING;

INSERT INTO payroll_line_items (employee_id, month, bank_account, tax_id, amount) VALUES
  (1, DATE '2026-01-01', 'US-000111', 'TAX-111', 7500.00),
  (1, DATE '2026-01-01', 'US-000111', 'TAX-111', 3750.00),
  (2, DATE '2026-01-01', 'US-000222', 'TAX-222', 6500.00),
  (2, DATE '2026-01-01', 'US-000222', 'TAX-222', 3250.00)
ON CONFLICT (employee_id, month, bank_account, tax_id, amount) DO NOTHING;
