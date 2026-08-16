# Concern: expose the pipeline package surface a backend imports — the Pipeline facade | Non-concern: the stage implementations (the submodules own those) | IO: none
from .pipeline import Pipeline

__all__ = ["Pipeline"]
