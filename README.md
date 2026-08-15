# OMODA

Multi-agent AI orchestration system. Hackathon project running on the shared
Acer Veriton GN100 (DGX Spark, `gn100-390c`), tailnet-only.

Sibling project: [`the8genc/leftovers`](https://github.com/the8genc/leftovers)
(computer vision). Both run on the same box and share its resources.

## Setup

The box, accounts, and team rules are shared between both projects and are
documented once, in the `leftovers` repo:

- **[spark-team-setup.md](https://github.com/the8genc/leftovers/blob/main/spark-team-setup.md)**: accounts, SSH, workspace
- **[docs/shared-infra-setup.md](https://github.com/the8genc/leftovers/blob/main/docs/shared-infra-setup.md)**: team rules, ports, memory

If you already have a box account, you have this repo too:

```bash
ssh gn100
source ~/env.sh        # sets OMODA_DIR, model endpoint, your port block
cd ~/omoda
```

## Shared resources

| | |
|---|---|
| Model endpoint | `http://100.71.143.26:8000/v1` (no API key; tailnet is the perimeter) |
| Model | `nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4` |
| Dashboard | `http://100.71.143.26:11000` |
| Model cache | `$HF_HOME`, 43 GB, shared, don't re-download |

`source ~/env.sh` exports `SPARK_LLM` and `SPARK_MODEL`, so use those rather
than hardcoding:

```python
import os
from openai import OpenAI

client = OpenAI(base_url=os.environ["SPARK_LLM"], api_key="x")
r = client.chat.completions.create(
    model=os.environ["SPARK_MODEL"],
    messages=[{"role": "system", "content": "/no_think"},
              {"role": "user", "content": "..."}],
    max_tokens=300, temperature=0,
)
m = r.choices[0].message
print(m.reasoning or m.content)   # reasoning model: answer lands in .reasoning
```

## Rules that matter here

Both projects share one box, so the constraints are shared too:

- **Memory is one pool and nearly full.** CPU and GPU share ~121 GiB; vLLM holds
  ~120 GiB. Run `spark-status.sh` before anything heavy. An OOM kill takes down
  the model server for both projects at once.
- **Stay in your port block.** An orchestrator that spawns agents can eat ports
  fast; keep every listener inside your 100-port range from `team.conf`.
- **The endpoint is shared and unmetered.** Many agents fanning out against one
  vLLM instance will queue. Bound your concurrency.
- **Branch per task**, `<yourname>/<feature>`. Keep `main` runnable.
