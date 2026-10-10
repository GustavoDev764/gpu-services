#!/usr/bin/env bash
set -euo pipefail
export VLLM_USE_FLASHINFER_SAMPLER=0
exec /opt/gpu-services/llm/.venv/bin/vllm serve "${LLM_MODEL_PATH:-/opt/gpu-services/models/gemma-3-27b-it}" \
  --served-model-name "${LLM_MODEL_NAME:-gemma-3-27b-it}" \
  --host 127.0.0.1 \
  --port "${LLM_PORT:-8001}" \
  --max-model-len "${LLM_MAX_MODEL_LEN:-32768}" \
  --gpu-memory-utilization "${LLM_GPU_MEMORY:-0.78}" \
  --max-num-seqs "${LLM_MAX_SEQS:-16}" \
  --limit-mm-per-prompt '{"image": 16}' \
  --enable-prefix-caching
