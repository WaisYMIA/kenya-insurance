#!/usr/bin/env python3
"""Builds services/api/src/data/catalogue.json from the uploaded ontology workbook (V2 Operational).
Re-run when the workbook changes:  python3 scripts/extract-catalogue.py <path-to-v2-workbook.xlsx>
Nothing is invented: every field below is copied from a workbook sheet. The only authored mapping is
CLAIM_DOMAINS (which Claims_Evidence domains apply to each customer-facing claim area)."""
import sys, json, datetime, collections, openpyxl

path = sys.argv[1] if len(sys.argv) > 1 else "Kenya_General_Insurance_Product_Ontology_v2_Operational.xlsx"
wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
rows = lambda s: [r for r in list(wb[s].iter_rows(values_only=True))[1:] if r and r[0]]

cov = {r[0]: {"id": r[0], "name": r[1], "definition": r[2]} for r in rows("Coverage_Components")}
prod_cov = collections.defaultdict(list)
for r in rows("Relationships_v2"):
    if r[0] == "PRODUCT" and r[2] == "has_coverage" and r[4] in cov and r[4] not in [c["id"] for c in prod_cov[r[1]]]:
        prod_cov[r[1]].append(cov[r[4]])

products = []
for r in rows("Ontology_Products"):
    products.append({
        "product_id": r[0], "class": r[1], "name": r[2], "target_segment": r[3], "insured_risk": r[4],
        "basis_of_sum_insured": r[5], "rating_factors": [f.strip() for f in (r[6] or "").split(";") if f.strip()],
        "coverages": prod_cov.get(r[0], []),
    })

classes = collections.OrderedDict()
for p in products: classes.setdefault(p["class"], []).append(p["product_id"])
reg = {r[1]: {"code": r[2], "class_code": r[0], "note": r[3]} for r in rows("Regulatory_Classes")}

out = {
    "source": path.split("/")[-1], "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
    "classes": [{"name": k, "ontology_code": reg.get(k, {}).get("code"), "product_ids": v} for k, v in classes.items()],
    "products": products,
    "coverage_components": list(cov.values()),
    "exclusions": [{"id": r[0], "name": r[1], "definition": r[2]} for r in rows("Exclusions")],
    "perils": [{"id": r[0], "name": r[1]} for r in rows("Perils")],
    "bundles": [{"id": r[0], "name": r[1], "components": r[2]} for r in rows("Bundles")],
    "claims_evidence": [{"id": r[0], "domain": r[1], "evidence": r[2], "purpose": r[3]} for r in rows("Claims_Evidence")],
    "underwriting_questions": [{"id": r[0], "domain": r[1], "topic": r[2], "question": r[3]} for r in rows("Underwriting_Questions")],
    # Authored mapping: customer-facing claim area -> Claims_Evidence.domain values that apply.
    "claim_domains": {
        "Motor": ["All", "Motor"], "Medical": ["All", "Medical"], "Home / property": ["All", "Property", "Property/Theft"],
        "Theft / burglary": ["All", "Property/Theft"], "Business / liability": ["All", "Liability", "Property"],
        "Personal accident / work injury": ["All", "PA/WIBA"], "Travel": ["All", "Medical"], "Other": ["All"],
    },
}
json.dump(out, open("services/api/src/data/catalogue.json", "w"), indent=1, ensure_ascii=False)
print(len(products), "products,", len(out["classes"]), "classes,", sum(1 for p in products if p["coverages"]), "with coverage mapping")
