# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts postcss.config.js tailwind.config.ts components.json ./
COPY src ./src
RUN pnpm build

FROM --platform=$BUILDPLATFORM rust:1-bookworm AS builder
WORKDIR /app
ARG TARGETARCH
ENV CARGO_NET_RETRY=10 \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc \
    AR_x86_64_unknown_linux_gnu=x86_64-linux-gnu-ar \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gcc-aarch64-linux-gnu \
    gcc-x86-64-linux-gnu \
    libc6-dev-amd64-cross \
    libc6-dev-arm64-cross \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p .cargo \
  && printf '%s\n' \
    '[target.x86_64-unknown-linux-gnu]' \
    'linker = "x86_64-linux-gnu-gcc"' \
    '' \
    '[target.aarch64-unknown-linux-gnu]' \
    'linker = "aarch64-linux-gnu-gcc"' \
    > .cargo/config.toml
COPY Cargo.lock ./
RUN printf '%s\n' \
  '[workspace]' \
  'members = ["carpo-core", "carpo-server"]' \
  'resolver = "2"' \
  > Cargo.toml
COPY carpo-core ./carpo-core
COPY carpo-server ./carpo-server
COPY src-tauri/scripts ./src-tauri/scripts
COPY src-tauri/pdfium ./src-tauri/pdfium
RUN bash src-tauri/scripts/fetch_pdfium.sh linux-x64 \
  && bash src-tauri/scripts/fetch_pdfium.sh linux-arm64
RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/app/target \
  case "${TARGETARCH}" in \
    amd64) rust_target="x86_64-unknown-linux-gnu" ;; \
    arm64) rust_target="aarch64-unknown-linux-gnu" ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && rustup target add "${rust_target}" \
  && cargo build --release --target "${rust_target}" -p carpo-server \
  && cp "/app/target/${rust_target}/release/carpo-server" /usr/local/bin/carpo-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --home-dir /home/carpo --shell /usr/sbin/nologin carpo \
  && mkdir -p /app /data \
  && chown -R carpo:carpo /app /data
WORKDIR /app
ARG TARGETARCH
COPY --from=builder /usr/local/bin/carpo-server /usr/local/bin/carpo-server
COPY --from=builder /app/src-tauri/pdfium/linux-x64/libpdfium.so /tmp/pdfium-linux-x64.so
COPY --from=builder /app/src-tauri/pdfium/linux-arm64/libpdfium.so /tmp/pdfium-linux-arm64.so
RUN case "${TARGETARCH}" in \
    amd64) cp /tmp/pdfium-linux-x64.so /app/libpdfium.so ;; \
    arm64) cp /tmp/pdfium-linux-arm64.so /app/libpdfium.so ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && rm -f /tmp/pdfium-linux-*.so \
  && chown carpo:carpo /app/libpdfium.so
COPY --from=frontend --chown=carpo:carpo /app/dist /app/dist
# 0.0.0.0 here, loopback in the binary's own default: inside a container the
# namespace is the boundary, and the published port is the operator's decision.
ENV CARPO_PORT=8787 \
    CARPO_BIND=0.0.0.0 \
    CARPO_STATIC_DIR=/app/dist \
    CARPO_DATA_DIR=/data \
    CARPO_PDFIUM_LIBRARY_PATH=/app/libpdfium.so
EXPOSE 8787
VOLUME ["/data"]
USER carpo
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${CARPO_PORT}/healthz" >/dev/null || exit 1
CMD ["carpo-server"]
