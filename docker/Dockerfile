# Optional container deployment. The lab's default is the conda environment.
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY ffc ./ffc
RUN pip install --no-cache-dir .
COPY config ./config
COPY frontend/dist ./frontend/dist
ENV FFC_HOST=0.0.0.0
EXPOSE 8050
# data/ and store/ are mounted at runtime (never baked into the image)
CMD ["sh", "-c", "ffc --project /app ingest && ffc --project /app serve --host ${FFC_HOST} --port 8050"]
