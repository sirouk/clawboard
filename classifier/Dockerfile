FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir requests fastembed numpy

COPY classifier.py /app/classifier.py
COPY embeddings_store.py /app/embeddings_store.py

ENV PYTHONUNBUFFERED=1
ENV CLASSIFIER_LOCK_PATH=/data/classifier.lock

CMD ["python", "/app/classifier.py"]
