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
