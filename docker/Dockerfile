# ComfyQ + ComfyUI for a GPU cloud machine (RunPod Pods, or any Docker host
# with an NVIDIA GPU). Build from the repo root:
#
#   docker build -f docker/Dockerfile -t comfyq .
#
# Models, outputs, the job queue and config live on the volume mounted at
# /workspace, never in the image. See docker/README.md.
#
# Layers run from least to most often changed, so editing ComfyQ's own code
# rebuilds only the last few: system → torch → ComfyUI → node packs → app.

ARG COMFYUI_VERSION=v0.42.1
# Node is pinned to an exact release and checked, so a cached layer can never
# hide an old one (24.22.0 sat in the image after the 2026-10-21 security
# release because the install layer was cached). Bump both lines together.
ARG NODE_VERSION=24.22.1
ARG NODE_DEB=24.22.1-1nodesource1

# ---- Client build (needs dev dependencies the runtime image does not) --------
FROM node:${NODE_VERSION}-bookworm-slim AS client
WORKDIR /src/client
COPY client/package.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- Runtime -------------------------------------------------------------------
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04
ARG COMFYUI_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# lsof: ComfyQ's "Restart & take over" finds the process on the ComfyUI port
# with it on Linux, and silently kills nothing without it. procps: pkill/pgrep,
# which entrypoint.sh uses to stop ComfyUI whenever ComfyQ restarts.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.12 python3.12-venv python3.12-dev build-essential \
        git curl ca-certificates ffmpeg lsof procps rsync \
        libgl1 libglib2.0-0 libsm6 libxext6 \
    && rm -rf /var/lib/apt/lists/*

# cloudflared: with COMFYQ_TUNNEL=quick the entrypoint opens a Cloudflare quick
# tunnel, so a machine with only a raw ip:port (Vast.ai) gets an https address
# on port 443 that school firewalls let through. Pinned and checked.
ARG CLOUDFLARED_VERSION=2026.9.3
ARG CLOUDFLARED_SHA256=77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2
RUN curl -fsSL -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
    && echo "${CLOUDFLARED_SHA256}  /usr/local/bin/cloudflared" | sha256sum -c - \
    && chmod +x /usr/local/bin/cloudflared

# ComfyQ strips VIRTUAL_ENV from ComfyUI's environment, so the venv is never
# "activated" — it is reached by the absolute path to its python, which is
# what config.json points at.
RUN python3.12 -m venv /opt/venv
COPY docker/constraints.txt /opt/docker/constraints.txt
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip wheel setuptools \
 && /opt/venv/bin/pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cu128 \
        torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0

RUN git clone --depth 1 --branch ${COMFYUI_VERSION} \
        https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
 && /opt/venv/bin/pip install --no-cache-dir -c /opt/docker/constraints.txt \
        -r /opt/ComfyUI/requirements.txt \
 && /opt/venv/bin/pip install --no-cache-dir -c /opt/docker/constraints.txt \
        sageattention==1.0.6

COPY docker/custom-nodes.txt docker/install-nodes.sh /opt/docker/
RUN bash /opt/docker/install-nodes.sh /opt/docker/custom-nodes.txt \
        /opt/ComfyUI/custom_nodes /opt/venv/bin/python

# ---- Node ------------------------------------------------------------------------
# Its own layer, after the heavy ones, so a Node security update rebuilds only
# from here on instead of torch, ComfyUI and every node pack.
ARG NODE_VERSION
ARG NODE_DEB
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION%%.*}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs=${NODE_DEB} \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(node -v)" = "v${NODE_VERSION}"

# ---- ComfyQ ----------------------------------------------------------------------
WORKDIR /app
COPY server/package.json server/
RUN npm install --prefix server --omit=dev --no-audit --no-fund
COPY . .
COPY --from=client /src/client/dist client/dist
RUN chmod +x docker/entrypoint.sh
# Our own fixes to cloned node packs (tools/maintenance/fix_custom_node_patches.py),
# the same ones the rig gets from Maintenance → "Re-apply the custom-node fixes".
# Without it the Qwen 2.1 ControlNet bundles fail every job with "aimdo memory
# compile error" (found on Thunder, 2026-10-20). A patch that no longer applies
# fails the build rather than shipping the bug.
RUN COMFY_ROOT=/opt/ComfyUI /opt/venv/bin/python tools/maintenance/fix_custom_node_patches.py

# 3000: ComfyQ (student page, admin panel, API). 8188: ComfyUI's own editor,
# used by the admin's "Open in ComfyUI".
EXPOSE 3000 8188
ENV COMFYQ_DATA=/workspace
# Which build this is, published in each Pod's heartbeat so Pods sharing a
# volume can tell when they run different builds. Set last, so a new commit
# does not invalidate the cached layers above.
ARG COMFYQ_IMAGE_SHA=unknown
ENV COMFYQ_IMAGE_SHA=${COMFYQ_IMAGE_SHA}
ENTRYPOINT ["/app/docker/entrypoint.sh"]
