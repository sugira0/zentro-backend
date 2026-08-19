-- Zentro Business Management — PostgreSQL schema
-- Run once on a fresh Neon / PostgreSQL database.
-- All dates stored as TIMESTAMPTZ. Booleans as BOOLEAN. Money as INTEGER (RWF cents).
-- UUIDs used for all TEXT PKs. Integer PKs (menu_items, ingredients, etc.) use SERIAL.

-- ── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Migrations tracker ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Platform / SaaS layer ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_modules (
  id          TEXT PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS business_types (
  id          TEXT PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS business_type_modules (
  business_type_id TEXT NOT NULL REFERENCES business_types(id) ON DELETE CASCADE,
  module_id        TEXT NOT NULL REFERENCES business_modules(id) ON DELETE CASCADE,
  PRIMARY KEY (business_type_id, module_id)
);

CREATE TABLE IF NOT EXISTS businesses (
  id               TEXT PRIMARY KEY,
  name             TEXT        NOT NULL,
  slug             TEXT UNIQUE NOT NULL,
  business_type_id TEXT        NOT NULL REFERENCES business_types(id),
  owner_name       TEXT        NOT NULL,
  owner_email      TEXT        NOT NULL,
  owner_phone      TEXT,
  status           TEXT        NOT NULL DEFAULT 'TRIAL',
  currency         TEXT        NOT NULL DEFAULT 'RWF',
  country          TEXT        NOT NULL DEFAULT 'Rwanda',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id            TEXT    PRIMARY KEY,
  code          TEXT    UNIQUE NOT NULL,
  name          TEXT    NOT NULL,
  monthly_price INTEGER NOT NULL,
  branch_limit  INTEGER NOT NULL,
  user_limit    INTEGER NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id             TEXT        PRIMARY KEY,
  business_id    TEXT        NOT NULL REFERENCES businesses(id),
  plan_id        TEXT        NOT NULL REFERENCES subscription_plans(id),
  status         TEXT        NOT NULL,
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at        TIMESTAMPTZ,
  billing_cycle  TEXT        NOT NULL DEFAULT 'MONTHLY',
  next_billing_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS business_module_assignments (
  business_id TEXT        NOT NULL REFERENCES businesses(id),
  module_id   TEXT        NOT NULL REFERENCES business_modules(id),
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, module_id)
);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id          TEXT        PRIMARY KEY,
  actor       TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   TEXT,
  details     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_seed_state (
  key        TEXT        PRIMARY KEY,
  seeded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Auth ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                   TEXT        PRIMARY KEY,
  email                TEXT UNIQUE NOT NULL,
  phone                TEXT UNIQUE,
  name                 TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ,
  password_hash        TEXT,
  password_salt        TEXT,
  user_type            TEXT        NOT NULL DEFAULT 'BUSINESS',
  platform_role        TEXT,
  email_verified_at    TIMESTAMPTZ,
  phone_verified_at    TIMESTAMPTZ,
  must_change_password BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id                  TEXT        PRIMARY KEY,
  user_id             TEXT        NOT NULL REFERENCES users(id),
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_business_id  TEXT,
  active_branch_id    TEXT,
  refresh_token_hash  TEXT,
  refresh_expires_at  TIMESTAMPTZ,
  device_name         TEXT,
  ip_address          TEXT,
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  rotated_from        TEXT
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_tokens (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES users(id),
  channel    TEXT        NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tenant core ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id          TEXT        PRIMARY KEY,
  business_id TEXT        NOT NULL REFERENCES businesses(id),
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  address     TEXT,
  status      TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, code)
);

CREATE TABLE IF NOT EXISTS warehouses (
  id          TEXT        PRIMARY KEY,
  business_id TEXT        NOT NULL REFERENCES businesses(id),
  branch_id   TEXT        REFERENCES branches(id),
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  address     TEXT,
  manager     TEXT,
  capacity    INTEGER,
  description TEXT,
  UNIQUE (business_id, code)
);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT        PRIMARY KEY,
  business_id TEXT        REFERENCES businesses(id),
  code        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  is_system   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, code)
);

CREATE TABLE IF NOT EXISTS permissions (
  id   TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS business_users (
  id                TEXT        PRIMARY KEY,
  business_id       TEXT        NOT NULL REFERENCES businesses(id),
  user_id           TEXT        NOT NULL REFERENCES users(id),
  role_id           TEXT        NOT NULL REFERENCES roles(id),
  default_branch_id TEXT        REFERENCES branches(id),
  status            TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by        TEXT,
  joined_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  UNIQUE (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT        PRIMARY KEY,
  business_id TEXT        REFERENCES businesses(id),
  branch_id   TEXT        REFERENCES branches(id),
  user_id     TEXT        REFERENCES users(id),
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   TEXT,
  details     TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id         TEXT        PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  name       TEXT        NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_feature_flags (
  business_id      TEXT        NOT NULL REFERENCES businesses(id),
  feature_flag_id  TEXT        NOT NULL REFERENCES feature_flags(id),
  enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, feature_flag_id)
);

CREATE TABLE IF NOT EXISTS tenant_business_settings (
  business_id TEXT        NOT NULL REFERENCES businesses(id),
  key         TEXT        NOT NULL,
  value       TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, key)
);

-- ── Products / Inventory ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL      PRIMARY KEY,
  key         TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id TEXT        REFERENCES businesses(id),
  UNIQUE (business_id, key)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id               SERIAL      PRIMARY KEY,
  name             TEXT        NOT NULL,
  category         TEXT        NOT NULL,
  price            INTEGER     NOT NULL,
  favorite         BOOLEAN     NOT NULL DEFAULT FALSE,
  image            TEXT,       -- R2 URL (was base64 data URL)
  available        BOOLEAN     NOT NULL DEFAULT TRUE,
  sku              TEXT,
  description      TEXT,
  location         TEXT        DEFAULT 'Main Warehouse',
  barcode          TEXT,
  unit             TEXT        DEFAULT 'Piece',
  cost             INTEGER     NOT NULL DEFAULT 0,
  supplier_id      TEXT,
  product_status   TEXT        NOT NULL DEFAULT 'ACTIVE',
  reorder_level    REAL        NOT NULL DEFAULT 5,
  track_stock      BOOLEAN     NOT NULL DEFAULT TRUE,
  business_id      TEXT        REFERENCES businesses(id),
  warehouse_id     TEXT        REFERENCES warehouses(id),
  menu_kind        TEXT        DEFAULT 'FOOD',
  dietary_tag      TEXT        DEFAULT 'NONE',
  preparation_time INTEGER     NOT NULL DEFAULT 0,
  has_variations   BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_business_sku
  ON menu_items (business_id, sku)
  WHERE business_id IS NOT NULL AND sku IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_business_barcode
  ON menu_items (business_id, barcode)
  WHERE business_id IS NOT NULL AND barcode IS NOT NULL AND barcode <> '';

CREATE TABLE IF NOT EXISTS ingredients (
  id            SERIAL      PRIMARY KEY,
  name          TEXT        NOT NULL,
  sku           TEXT        NOT NULL,
  unit          TEXT        NOT NULL,
  quantity      REAL        NOT NULL DEFAULT 0,
  reorder_level REAL        NOT NULL DEFAULT 0,
  unit_cost     INTEGER     NOT NULL DEFAULT 0,
  supplier      TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id   TEXT        REFERENCES businesses(id),
  warehouse_id  TEXT        REFERENCES warehouses(id),
  UNIQUE (business_id, sku)
);

CREATE TABLE IF NOT EXISTS recipe_components (
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  quantity      REAL    NOT NULL CHECK (quantity > 0),
  business_id   TEXT    REFERENCES businesses(id),
  PRIMARY KEY (menu_item_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id            TEXT        PRIMARY KEY,
  ingredient_id INTEGER     REFERENCES ingredients(id),
  type          TEXT        NOT NULL,
  quantity      REAL        NOT NULL,
  reason        TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id   TEXT        REFERENCES businesses(id),
  branch_id     TEXT        REFERENCES branches(id),
  warehouse_id  TEXT        REFERENCES warehouses(id)
);

-- ── Orders / Sales ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT        PRIMARY KEY,
  order_number        INTEGER     NOT NULL,
  type                TEXT        NOT NULL,
  table_name          TEXT,
  guests              INTEGER     NOT NULL DEFAULT 1,
  status              TEXT        NOT NULL,
  subtotal            INTEGER     NOT NULL,
  discount            INTEGER     NOT NULL DEFAULT 0,
  tax                 INTEGER     NOT NULL DEFAULT 0,
  total               INTEGER     NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at             TIMESTAMPTZ,
  business_id         TEXT        REFERENCES businesses(id),
  branch_id           TEXT        REFERENCES branches(id),
  inventory_deducted  BOOLEAN     NOT NULL DEFAULT FALSE,
  UNIQUE (business_id, order_number)
);

CREATE TABLE IF NOT EXISTS order_items (
  id           SERIAL  PRIMARY KEY,
  order_id     TEXT    NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  unit_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL,
  business_id  TEXT    REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT        PRIMARY KEY,
  order_id    TEXT        NOT NULL REFERENCES orders(id),
  method      TEXT        NOT NULL,
  amount      INTEGER     NOT NULL,
  status      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id TEXT        REFERENCES businesses(id),
  branch_id   TEXT        REFERENCES branches(id)
);

-- ── Customers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id            TEXT        PRIMARY KEY,
  business_id   TEXT        NOT NULL REFERENCES businesses(id),
  branch_id     TEXT        REFERENCES branches(id),
  name          TEXT        NOT NULL,
  phone         TEXT,
  email         TEXT,
  status        TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  company       TEXT,
  group_name    TEXT,
  location      TEXT,
  updated_at    TIMESTAMPTZ,
  customer_type TEXT,
  tin           TEXT
);

-- ── Suppliers / Procurement ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_suppliers (
  id             TEXT        PRIMARY KEY,
  name           TEXT        NOT NULL,
  contact        TEXT,
  phone          TEXT,
  email          TEXT,
  status         TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  category       TEXT,
  country        TEXT,
  payment_terms  TEXT,
  outstanding    INTEGER     DEFAULT 0,
  lead_time      INTEGER     DEFAULT 0,
  quality_rating REAL        DEFAULT 0,
  on_time_rate   REAL        DEFAULT 0,
  business_id    TEXT        REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT        PRIMARY KEY,
  po_number     TEXT        NOT NULL,
  supplier_id   TEXT        REFERENCES business_suppliers(id),
  status        TEXT        NOT NULL,
  total         INTEGER     NOT NULL DEFAULT 0,
  item_count    INTEGER     NOT NULL DEFAULT 0,
  expected_date DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id   TEXT        REFERENCES businesses(id),
  branch_id     TEXT        REFERENCES branches(id),
  warehouse_id  TEXT        REFERENCES warehouses(id),
  UNIQUE (business_id, po_number)
);

CREATE TABLE IF NOT EXISTS inventory_transfers (
  id            TEXT        PRIMARY KEY,
  reference     TEXT        NOT NULL,
  from_location TEXT        NOT NULL,
  to_location   TEXT        NOT NULL,
  status        TEXT        NOT NULL,
  item_count    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id   TEXT        REFERENCES businesses(id),
  branch_id     TEXT        REFERENCES branches(id),
  warehouse_id  TEXT        REFERENCES warehouses(id),
  UNIQUE (business_id, reference)
);

-- ── Loans ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loans (
  id                    TEXT        PRIMARY KEY,
  borrower_name         TEXT        NOT NULL,
  borrower_phone        TEXT,
  borrower_email        TEXT,
  borrower_type         TEXT        NOT NULL,
  principal             INTEGER     NOT NULL,
  amount_paid           INTEGER     NOT NULL DEFAULT 0,
  due_date              DATE        NOT NULL,
  status                TEXT        NOT NULL,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id           TEXT        REFERENCES businesses(id),
  branch_id             TEXT        REFERENCES branches(id),
  last_reminder_sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS loan_repayments (
  id          TEXT        PRIMARY KEY,
  loan_id     TEXT        REFERENCES loans(id),
  amount      INTEGER     NOT NULL,
  method      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id TEXT        REFERENCES businesses(id)
);

-- ── Expenses ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id             TEXT        PRIMARY KEY,
  business_id    TEXT        NOT NULL REFERENCES businesses(id),
  branch_id      TEXT        REFERENCES branches(id),
  category       TEXT        NOT NULL,
  amount         INTEGER     NOT NULL,
  description    TEXT,
  incurred_at    TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payment_method TEXT,
  status         TEXT        DEFAULT 'PAID',
  reference      TEXT,
  notes          TEXT,
  updated_at     TIMESTAMPTZ
);

-- ── Accounting ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounting_journals (
  id          TEXT        PRIMARY KEY,
  business_id TEXT        NOT NULL REFERENCES businesses(id),
  branch_id   TEXT        REFERENCES branches(id),
  reference   TEXT        NOT NULL,
  entry_date  DATE        NOT NULL,
  description TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'POSTED',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, reference)
);

CREATE TABLE IF NOT EXISTS accounting_journal_lines (
  id           TEXT    PRIMARY KEY,
  journal_id   TEXT    NOT NULL REFERENCES accounting_journals(id),
  business_id  TEXT    NOT NULL,
  account_code TEXT    NOT NULL,
  account_name TEXT    NOT NULL,
  debit        INTEGER NOT NULL DEFAULT 0,
  credit       INTEGER NOT NULL DEFAULT 0
);

-- ── Cash & Bank ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_accounts (
  id              TEXT        PRIMARY KEY,
  business_id     TEXT        NOT NULL REFERENCES businesses(id),
  branch_id       TEXT        REFERENCES branches(id),
  name            TEXT        NOT NULL,
  type            TEXT        NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'RWF',
  bank_name       TEXT,
  account_number  TEXT,
  opening_balance INTEGER     NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_transactions (
  id                 TEXT        PRIMARY KEY,
  business_id        TEXT        NOT NULL REFERENCES businesses(id),
  branch_id          TEXT        REFERENCES branches(id),
  account_id         TEXT        NOT NULL REFERENCES cash_accounts(id),
  counter_account_id TEXT,
  type               TEXT        NOT NULL,
  amount             INTEGER     NOT NULL,
  description        TEXT        NOT NULL,
  reference          TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'COMPLETED',
  transaction_date   DATE        NOT NULL,
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id                 TEXT        PRIMARY KEY,
  business_id        TEXT        NOT NULL REFERENCES businesses(id),
  branch_id          TEXT        REFERENCES branches(id),
  account_id         TEXT        NOT NULL REFERENCES cash_accounts(id),
  statement_balance  INTEGER     NOT NULL,
  reconciled_balance INTEGER     NOT NULL,
  status             TEXT        NOT NULL,
  reconciled_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Invoices ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT        PRIMARY KEY,
  invoice_number  TEXT        NOT NULL,
  business_id     TEXT        NOT NULL REFERENCES businesses(id),
  branch_id       TEXT        NOT NULL,
  source_order_id TEXT,
  customer_name   TEXT        NOT NULL,
  customer_email  TEXT,
  issued_at       TIMESTAMPTZ NOT NULL,
  due_at          TIMESTAMPTZ NOT NULL,
  total           INTEGER     NOT NULL,
  paid            INTEGER     NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          TEXT        PRIMARY KEY,
  invoice_id  TEXT        NOT NULL REFERENCES invoices(id),
  business_id TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  quantity    REAL        NOT NULL,
  unit_price  INTEGER     NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id          TEXT        PRIMARY KEY,
  invoice_id  TEXT        NOT NULL REFERENCES invoices(id),
  business_id TEXT        NOT NULL,
  branch_id   TEXT        NOT NULL,
  amount      INTEGER     NOT NULL,
  method      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Proforma ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proformas (
  id                   TEXT        PRIMARY KEY,
  proforma_number      TEXT        NOT NULL,
  business_id          TEXT        NOT NULL REFERENCES businesses(id),
  branch_id            TEXT        NOT NULL,
  customer_name        TEXT        NOT NULL,
  customer_email       TEXT,
  customer_phone       TEXT,
  customer_address     TEXT,
  status               TEXT        NOT NULL DEFAULT 'DRAFT',
  template             TEXT        NOT NULL DEFAULT 'classic',
  issued_at            TIMESTAMPTZ NOT NULL,
  valid_until          TIMESTAMPTZ NOT NULL,
  subtotal             INTEGER     NOT NULL,
  discount             INTEGER     NOT NULL DEFAULT 0,
  tax                  INTEGER     NOT NULL DEFAULT 0,
  total                INTEGER     NOT NULL,
  terms                TEXT,
  notes                TEXT,
  converted_order_id   TEXT,
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bank_name            TEXT,
  bank_account_name    TEXT,
  bank_account_number  TEXT,
  momo_name            TEXT,
  momo_number          TEXT,
  company_stamp        TEXT,
  company_signature    TEXT,
  signatory_name       TEXT,
  signatory_title      TEXT,
  UNIQUE (business_id, proforma_number)
);

CREATE TABLE IF NOT EXISTS proforma_items (
  id           TEXT    PRIMARY KEY,
  proforma_id  TEXT    NOT NULL REFERENCES proformas(id),
  business_id  TEXT    NOT NULL,
  menu_item_id INTEGER,
  name         TEXT    NOT NULL,
  quantity     REAL    NOT NULL,
  unit_price   INTEGER NOT NULL
);

-- ── Returns ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_returns (
  id                TEXT        PRIMARY KEY,
  return_number     TEXT UNIQUE NOT NULL,
  order_id          TEXT        NOT NULL REFERENCES orders(id),
  reason            TEXT        NOT NULL,
  refund_method     TEXT        NOT NULL,
  refund_amount     INTEGER     NOT NULL,
  status            TEXT        NOT NULL,
  restocked         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id       TEXT        NOT NULL REFERENCES businesses(id),
  branch_id         TEXT        NOT NULL,
  requested_restock BOOLEAN     NOT NULL DEFAULT FALSE,
  reviewed_at       TIMESTAMPTZ,
  refunded_at       TIMESTAMPTZ,
  review_note       TEXT,
  updated_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id           TEXT    PRIMARY KEY,
  return_id    TEXT    NOT NULL,
  menu_item_id INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  unit_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL,
  business_id  TEXT    NOT NULL
);

-- ── Notifications ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_notifications (
  id           TEXT        PRIMARY KEY,
  business_id  TEXT        NOT NULL REFERENCES businesses(id),
  branch_id    TEXT,
  type         TEXT        NOT NULL,
  severity     TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  message      TEXT        NOT NULL,
  source_key   TEXT        NOT NULL,
  action_view  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  audience_role TEXT,
  UNIQUE (business_id, source_key)
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id TEXT        NOT NULL REFERENCES tenant_notifications(id),
  user_id         TEXT        NOT NULL,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, user_id)
);

-- ── Staff ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_profiles (
  id            TEXT        PRIMARY KEY,
  business_id   TEXT        NOT NULL REFERENCES businesses(id),
  branch_id     TEXT,
  user_id       TEXT        NOT NULL,
  employee_code TEXT        NOT NULL,
  department    TEXT        NOT NULL,
  job_title     TEXT,
  gender        TEXT,
  birth_date    DATE,
  join_date     DATE        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, user_id),
  UNIQUE (business_id, employee_code)
);

-- ── Reports ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generated_reports (
  id           TEXT        PRIMARY KEY,
  business_id  TEXT        NOT NULL REFERENCES businesses(id),
  branch_id    TEXT,
  report_name  TEXT        NOT NULL,
  report_type  TEXT        NOT NULL,
  date_from    DATE,
  date_to      DATE,
  format       TEXT        NOT NULL DEFAULT 'PDF',
  generated_by TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Restaurant tables ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id          TEXT        PRIMARY KEY,
  business_id TEXT        NOT NULL REFERENCES businesses(id),
  branch_id   TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  area        TEXT        NOT NULL DEFAULT 'Main Dining',
  capacity    INTEGER     NOT NULL DEFAULT 2,
  status      TEXT        NOT NULL DEFAULT 'AVAILABLE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, branch_id, code)
);

-- ── Tenant system ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_system_events (
  id          TEXT        PRIMARY KEY,
  business_id TEXT        NOT NULL,
  user_id     TEXT,
  action      TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  details     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_backups (
  id            TEXT        PRIMARY KEY,
  business_id   TEXT        NOT NULL,
  branch_id     TEXT,
  name          TEXT        NOT NULL,
  type          TEXT        NOT NULL,
  status        TEXT        NOT NULL,
  size_bytes    INTEGER     NOT NULL DEFAULT 0,
  snapshot_json TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

-- ── Platform admin ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_announcements (
  id           TEXT        PRIMARY KEY,
  title        TEXT        NOT NULL,
  message      TEXT        NOT NULL,
  audience     TEXT        NOT NULL,
  status       TEXT        NOT NULL,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type         TEXT        NOT NULL DEFAULT 'GENERAL',
  expires_at   TIMESTAMPTZ,
  created_by   TEXT
);

CREATE TABLE IF NOT EXISTS support_requests (
  id              TEXT        PRIMARY KEY,
  business_id     TEXT        REFERENCES businesses(id),
  subject         TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'OPEN',
  priority        TEXT        NOT NULL DEFAULT 'MEDIUM',
  requested_by    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  message         TEXT,
  branch_id       TEXT,
  resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS support_access_sessions (
  id                TEXT        PRIMARY KEY,
  business_id       TEXT        NOT NULL REFERENCES businesses(id),
  superadmin_user_id TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  status            TEXT        NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at        TIMESTAMPTZ,
  request_id        TEXT
);

CREATE TABLE IF NOT EXISTS platform_backups (
  id           TEXT        PRIMARY KEY,
  scope        TEXT        NOT NULL,
  status       TEXT        NOT NULL,
  size_bytes   BIGINT,
  requested_by TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  file_path    TEXT
);

CREATE TABLE IF NOT EXISTS platform_exports (
  id           TEXT        PRIMARY KEY,
  type         TEXT        NOT NULL,
  status       TEXT        NOT NULL,
  requested_by TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  file_name    TEXT
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id              TEXT        PRIMARY KEY,
  subscription_id TEXT        REFERENCES subscriptions(id),
  amount          INTEGER     NOT NULL,
  status          TEXT        NOT NULL,
  provider        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_change_requests (
  id             TEXT        PRIMARY KEY,
  business_id    TEXT        NOT NULL REFERENCES businesses(id),
  subscription_id TEXT       NOT NULL,
  old_plan_id    TEXT,
  new_plan_id    TEXT        NOT NULL,
  billing_cycle  TEXT        NOT NULL,
  status         TEXT        NOT NULL,
  requested_by   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_setting_changes (
  id             TEXT        PRIMARY KEY,
  setting_key    TEXT        NOT NULL,
  previous_value TEXT,
  new_value      TEXT,
  reason         TEXT        NOT NULL,
  updated_by     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Shipments / Deliveries ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipments (
  id           TEXT        PRIMARY KEY,
  business_id  TEXT        NOT NULL REFERENCES businesses(id),
  branch_id    TEXT        REFERENCES branches(id),
  warehouse_id TEXT        REFERENCES warehouses(id),
  reference    TEXT        NOT NULL,
  status       TEXT        NOT NULL,
  origin       TEXT,
  destination  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, reference)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id           TEXT        PRIMARY KEY,
  business_id  TEXT        NOT NULL REFERENCES businesses(id),
  branch_id    TEXT        REFERENCES branches(id),
  warehouse_id TEXT        REFERENCES warehouses(id),
  reference    TEXT        NOT NULL,
  status       TEXT        NOT NULL,
  address      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, reference)
);

-- ── Public storefront ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_order_details (
  order_id       TEXT        PRIMARY KEY,
  business_id    TEXT        NOT NULL,
  branch_id      TEXT        NOT NULL,
  customer_name  TEXT        NOT NULL,
  customer_phone TEXT        NOT NULL,
  customer_email TEXT,
  address        TEXT,
  notes          TEXT,
  fulfillment    TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Public contact ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public_contact_enquiries (
  id            TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  phone         TEXT,
  business_name TEXT,
  topic         TEXT        NOT NULL,
  message       TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'NEW',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Performance indexes ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_menu_items_business   ON menu_items(business_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_business  ON ingredients(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_business       ON orders(business_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_orders_created        ON orders(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order        ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_biz   ON stock_movements(business_id, ingredient_id);
CREATE INDEX IF NOT EXISTS idx_loans_business        ON loans(business_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_business     ON expenses(business_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user    ON auth_sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_notifications_biz     ON tenant_notifications(business_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone    ON users(phone) WHERE phone IS NOT NULL;
