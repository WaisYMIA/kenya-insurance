-- 001_motor_pilot_product.sql
-- Motor is ONE product line covering every vehicle category (motorcycle, private car,
-- commercial vehicle, PSV, hire/reward) — category is an attribute of the quote request, not a
-- separate product, matching Lami's own "Motor insurance" line (lami.world/individual-motor-insurance.html)
-- and V3 Product_Rules (PR-001 private use ELIGIBLE, PR-002 commercial/hire/PSV use -> REFER).
-- No premium/tax rate is set to a number anywhere in this file — see master brief §4.

INSERT INTO products (product_id, product_name, product_family, regulatory_class) VALUES
    ('MOT-TP-001', 'Motor Third Party', 'Motor', 'Motor - Third Party'),
    ('MOT-COMP-001', 'Motor Comprehensive', 'Motor', 'Motor - Comprehensive');

INSERT INTO product_versions (product_id, version_label, insurer, effective_from, status) VALUES
    ('MOT-TP-001', '2026.PILOT.1', NULL, CURRENT_DATE, 'DRAFT'),
    ('MOT-COMP-001', '2026.PILOT.1', NULL, CURRENT_DATE, 'DRAFT');

INSERT INTO coverages (coverage_id, coverage_name, coverage_description) VALUES
    ('COV-001', 'Own Damage', 'Physical damage to the insured vehicle (accident, collision, theft, vandalism per Lami reference cover list)'),
    ('COV-002', 'Third Party Liability', 'Statutory third-party liability cover');

INSERT INTO product_coverages (product_version_id, coverage_id, is_mandatory)
SELECT product_version_id, 'COV-002', true FROM product_versions WHERE product_id IN ('MOT-TP-001','MOT-COMP-001');
INSERT INTO product_coverages (product_version_id, coverage_id, is_mandatory)
SELECT product_version_id, 'COV-001', false FROM product_versions WHERE product_id = 'MOT-COMP-001';

-- Rules — mirrors V3 Product_Rules exactly (private use eligible, commercial/PSV/hire -> refer)
INSERT INTO rules (rule_id, rule_type, rule_name) VALUES
    ('PR-MOT-001', 'eligibility', 'Private/social vehicle use — any category'),
    ('PR-MOT-002', 'eligibility', 'Commercial/PSV/hire-reward use requires underwriting review'),
    ('PR-MOT-003', 'eligibility', 'Comprehensive requires declared vehicle value');

INSERT INTO rule_versions (rule_id, product_id, condition_expression, action, source_reference, status, effective_from) VALUES
    ('PR-MOT-001', 'MOT-TP-001', 'usage_type IN (''private'',''social_domestic_pleasure'')', 'ELIGIBLE',
     'Insurance (Motor Vehicle Third Party Risks) Act; approved policy wording', 'TEMPLATE', CURRENT_DATE),
    ('PR-MOT-002', NULL, 'vehicle_category IN (''COMMERCIAL_VEHICLE'',''PSV'',''HIRE_REWARD'') OR usage_type IN (''hire_reward'',''commercial'',''PSV'')', 'REFER',
     'Approved policy wording / insurer underwriting manual (mirrors V3 PR-002)', 'TEMPLATE', CURRENT_DATE),
    ('PR-MOT-003', 'MOT-COMP-001', 'cover_type = ''COMPREHENSIVE'' AND vehicle_value_kes IS NULL', 'BLOCK_UNTIL_VALUE_SUPPLIED',
     'Approved product/rating rule', 'TEMPLATE', CURRENT_DATE);

-- Rate configuration — formula shape only, applies across all vehicle categories for this product
INSERT INTO rate_configurations (product_id, coverage_id, formula_type, formula_expression, rate_status, source_reference, effective_from) VALUES
    ('MOT-COMP-001', 'COV-001', 'rate_on_vehicle_value', 'premium = vehicle_value * technical_rate (rate may vary by vehicle_category — insurer to supply per-category rate table)',
     'CONFIGURATION_REQUIRED', 'Approved motor product/rating basis — insurer to supply technical_rate', CURRENT_DATE),
    ('MOT-TP-001', 'COV-002', 'flat_or_statutory', 'premium = statutory_or_insurer_schedule (may vary by vehicle_category)',
     'CONFIGURATION_REQUIRED', 'Insurance (Motor Vehicle Third Party Risks) Act Cap.405 — insurer/statutory schedule required', CURRENT_DATE);

-- Statutory/likely charges — values intentionally left as CONFIGURE, matching V3 Taxes_Levies
INSERT INTO charges (charge_id, charge_name, payer, basis, rate_or_amount, rate_status, source_reference, calculation_order) VALUES
    ('TL-001', 'Insurance Premium Levy', 'insurer / as prescribed', 'gross direct premium / prescribed basis', 'CONFIGURE', 'SOURCE_CONTROLLED', 'Insurance Act s.197A and current order', 'after_base_premium'),
    ('TL-002', 'Insurance Training Levy', 'policyholder via insurer', 'gross direct premiums written / prescribed basis', 'CONFIGURE', 'SOURCE_CONTROLLED', 'Insurance Act s.197B and current order', 'after_base_premium'),
    ('TL-003', 'Policyholders'' Compensation Fund contribution', 'insurer + policyholder', 'premium / applicable policy', '0.25% each party', 'SOURCE_DATED_2010_RULE', 'Insurance (Policyholders'' Compensation Fund) Regulations, 2010, reg.9', 'after_base_premium');

INSERT INTO integrations (integration_id, integration_name, environment, status) VALUES
    ('LAMI', 'Lami distribution platform adapter', 'SANDBOX', 'CREDENTIALS_REQUIRED'),
    ('WHATSAPP_BSP', 'WhatsApp Business Solution Provider', 'SANDBOX', 'CREDENTIALS_REQUIRED'),
    ('PAYMENT_PROVIDER', 'Payment provider', 'SANDBOX', 'CREDENTIALS_REQUIRED'),
    ('LIPA_POLE_POLE', 'Financing provider', 'SANDBOX', 'CREDENTIALS_REQUIRED'),
    ('OCR_PROVIDER', 'Document OCR/identity verification', 'SANDBOX', 'CREDENTIALS_REQUIRED'),
    ('EMAIL_PROVIDER', 'Outbound email (SMTP/API)', 'SANDBOX', 'CREDENTIALS_REQUIRED');
