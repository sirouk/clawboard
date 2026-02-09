FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY docker-entrypoint.sh /usr/local/bin/clawboard-entrypoint.sh
RUN chmod +x /usr/local/bin/clawboard-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/clawboard-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
