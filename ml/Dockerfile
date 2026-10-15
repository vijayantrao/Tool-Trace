# syntax=docker/dockerfile:1
# Build context: repository root  ->  docker build -f ml/Dockerfile .
FROM python:3.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY ml/requirements.txt .
# Patch OS packages, install the pinned dependencies, then remove pip: the job never installs anything.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* \
    && pip install -r requirements.txt \
    && python -m pip uninstall -y pip
COPY ml/tooltrace_ml ./tooltrace_ml
# Never run as root inside the container.
USER 65534:65534
CMD ["python", "-m", "tooltrace_ml", "run"]
