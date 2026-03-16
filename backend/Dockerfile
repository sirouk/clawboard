FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY docker-entrypoint.sh /usr/local/bin/clawboard-entrypoint.sh
RUN chmod +x /usr/local/bin/clawboard-entrypoint.sh

RUN addgroup --system --gid 1001 clawboard && \
    adduser --system --uid 1001 --gid 1001 clawboard && \
    mkdir -p /app/data && chown clawboard:clawboard /app/data

USER clawboard

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"]

ENTRYPOINT ["/usr/local/bin/clawboard-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
