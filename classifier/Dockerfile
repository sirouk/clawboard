FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir requests

COPY classifier.py /app/classifier.py

ENV PYTHONUNBUFFERED=1

CMD ["python", "/app/classifier.py"]
