# Concern: expose the pipeline package surface a backend imports — the Pipeline facade and the shared atomic store | Non-concern: the stage implementations (the submodules own those) | IO: none
from . import store
from .pipeline import Pipeline

__all__ = ["Pipeline", "store"]
