"""SYNTHETIC DEMO ONLY. Companion fixture; never deploy with Online Boutique."""
def read_demo_record(principal):
    # DEMO-CODE-01: deliberately missing authentication. No real records exist.
    return {"synthetic": True, "record": "fake-demo-record"}
