# gpu-services

API (sem frontend) que roda na GPU os modelos do ManhwaLab:

- **detect**: balões e texto com [`ogkalu/comic-text-and-bubble-detector`](https://huggingface.co/ogkalu/comic-text-and-bubble-detector) (RT-DETR). Páginas altas de webtoon são divididas em blocos sobrepostos.
- **inpaint**: LaMa (`big-lama.pt`) apaga o que a máscara marcar, só dentro de janelas ao redor da máscara.

Cada pedido vira um **job** numa fila (BullMQ/Redis). Quando termina, o serviço chama o **webhook** do cliente com assinatura HMAC. O resultado fica disponível por 48 h.

```
cliente ──POST /jobs/detect|inpaint──▶ API (NestJS) ──fila──▶ worker (Python, GPU)
   ▲                                       │                      │
   └──────── webhook assinado ◀────────────┴──── Redis (estado) ◀─┘
```

## Peças

| Pasta | O que é |
|---|---|
| `src/` | API NestJS: jobs, upload, arquivos, webhook com tentativas, chaves de cliente, configurações, limpeza, saúde |
| `worker/gpu_worker/` | Worker Python: carrega os dois modelos uma vez na GPU, processa em lotes, decodifica em paralelo com a GPU |
| `deploy/` | Instalação nativa (systemd + Redis com AOF) |
| `scripts/check.ts` | Teste de ponta a ponta (`npm run check`) |

Redis é o único banco: filas, jobs (`gpu:job:<id>`), resultados, entregas do webhook, clientes e configurações. Os arquivos ficam em `DATA_DIR/jobs/<id>/`.

## API

Toda rota (menos `/health`) exige `Authorization: Bearer <chave>`. A chave de administração (`ADMIN_KEY`) só acessa `/admin/*`; jobs usam chaves de cliente.

| Rota | Descrição |
|---|---|
| `POST /jobs/detect` | multipart: `pages` (arquivos), `callbackUrl`, `externalId`, `priority` (`high`/`normal`), `threshold`, `tiles` (`true`/`false`) |
| `POST /jobs/inpaint` | multipart: `images` e `masks` na mesma ordem (máscara branca ou com alfa = apagar), `callbackUrl`, `externalId`, `priority`, `context` (px de contexto ao redor da máscara) |
| `GET /jobs/:id` | estado, progresso, tempos e resultado por arquivo |
| `GET /jobs/:id/files/:nome` | imagem gerada (PNG) |
| `GET /jobs/:id/files.zip` | todas as imagens geradas |
| `DELETE /jobs/:id` | cancela |
| `GET /health` | sem chave: worker (GPU, VRAM, modelos), filas, disco |
| `GET/PUT /admin/settings` | lotes, concorrência por fila, fp16, limiar, blocos (valem na hora) |
| `GET/POST/DELETE /admin/clients` | chaves de cliente; a chave e o segredo do webhook aparecem só na criação |

Resultado de detecção por página (mesmo formato do `detect.py` do ManhwaLab):

```json
{ "name": "001.webp", "status": "done", "width": 800, "height": 12000, "tiles": 6,
  "detections": [ { "label": "bubble", "score": 0.93, "box": [112, 340, 520, 610] } ] }
```

### Webhook

`POST callbackUrl` quando o job termina (`succeeded`, `failed` ou `canceled`):

```
x-gpu-event: job.finished
x-gpu-delivery: d_...
x-gpu-timestamp: 1791650000
x-gpu-signature: sha256=hex(HMAC_SHA256(webhookSecret, timestamp + "." + corpo))
```

Sem resposta 2xx em 10 s, tenta de novo em 10 s, 30 s, 2 min, 10 min, 30 min e 2 h. Recuse assinaturas inválidas ou com timestamp de mais de 5 min.

## Configuração

| Variável | Padrão | |
|---|---|---|
| `ADMIN_KEY` | (obrigatória, 16+ caracteres) | chave de administração |
| `REDIS_URL` / `REDIS_DB` | `redis://127.0.0.1:6379` / `0` | |
| `KEY_PREFIX` / `QUEUE_PREFIX` | `gpu` / `bull` | prefixos no Redis |
| `DATA_DIR` | `./data` | uploads e resultados |
| `API_HOST` / `API_PORT` | `0.0.0.0` / `8000` | |
| `PUBLIC_URL` | `http://127.0.0.1:8000` | base dos links nos resultados e no webhook |
| `JOB_TTL_SECONDS` | `172800` | por quanto tempo o job e os arquivos ficam |
| `MAX_UPLOAD_MB` / `MAX_FILES` | `40` / `2000` | por arquivo / por job |
| `DISK_LIMIT_PERCENT` | `80` | acima disso recusa jobs novos (507) |
| `WEBHOOK_DELAYS_MS` | `10000,30000,120000,600000,1800000,7200000` | |
| `DEVICE` | `auto` | `cuda`, `cpu` ou `auto` |
| `LAMA_MODEL` / `DETECTOR_MODEL` | baixa no primeiro uso | caminhos locais dos modelos |
| `DECODE_THREADS` / `TORCH_THREADS` | `2` / `0` | |

## Instalar no servidor da GPU (Ubuntu 24.04, systemd)

```bash
sudo ./deploy/install.sh
curl http://127.0.0.1:8000/health
sudo grep ADMIN_KEY /etc/gpu-services.env
```

Instala Redis (AOF), Node 24, torch com CUDA, baixa os modelos para `models/` e cria os serviços `gpu-api` e `gpu-worker`. Logs: `journalctl -u gpu-worker -f`.

## Desenvolvimento

```bash
npm install
python -m venv worker/.venv && worker/.venv/Scripts/pip install torch torchvision -r worker/requirements.txt
npm run start:dev
cd worker && .venv/Scripts/python -m gpu_worker.main
ADMIN_KEY=... npm run check
python -m gpu_worker.bench <pasta com páginas>
```
