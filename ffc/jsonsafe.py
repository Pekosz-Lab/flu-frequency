"""JSON-safe conversion of query results."""


def clean(x):
    """Make values JSON-safe: NaN/NaT -> None, numpy scalars -> Python."""
    import math

    import numpy as np
    import pandas as pd

    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, np.generic):
        x = x.item()
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    if x is pd.NaT:
        return None
    if hasattr(x, "isoformat"):
        return x.isoformat()
    return x
