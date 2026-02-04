FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir requests fastembed numpy

COPY classifier.py /app/classifier.py
COPY embeddings_store.py /app/embeddings_store.py

ENV PYTHONUNBUFFERED=1

CMD ["python", "/app/classifier.py"]
