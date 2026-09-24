import time
from typing import Optional, List, Dict, Any
import httpx
from .errors import CbeVerifyError, CbeVerifyNetworkError

DEFAULT_BASE = "http://localhost:3000"


class CbeVerifyClient:
    def __init__(self, api_key, base_url=DEFAULT_BASE, timeout=35.0, max_retries=3,
                 poll_interval=2.0, max_poll_attempts=20):
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.poll_interval = poll_interval
        self.max_poll_attempts = max_poll_attempts
        self._client = httpx.Client(timeout=timeout)

    def verify(self, bank, reference_number, account_suffix=None,
               webhook_url=None, wait_ms=30000, idempotency_key=None):
        url = self.base_url + "/api/verify?waitMs=" + str(wait_ms)
        headers = {}
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        body = {"bank": bank, "referenceNumber": reference_number}
        if account_suffix:
            body["accountSuffix"] = account_suffix
        if webhook_url:
            body["webhookUrl"] = webhook_url
        res = self._request("POST", url, body=body, extra_headers=headers)
        if res.status_code == 200:
            return res.json()
        if res.status_code == 202:
            data = res.json()
            status_url = data.get("statusUrl")
            if status_url:
                return self._poll_until_done(status_url, data)
        raise CbeVerifyError(res.json().get("message", "HTTP " + str(res.status_code)),
                             status=res.status_code, body=self._safe_json(res))

    def _poll_until_done(self, status_url, initial):
        url = status_url if status_url.startswith("http") else self.base_url + status_url
        for _ in range(self.max_poll_attempts):
            time.sleep(self.poll_interval)
            res = self._request("GET", url)
            if res.status_code != 200:
                continue
            data = res.json().get("data", {})
            ps = data.get("processingStatus")
            if ps in ("completed", "failed"):
                return res.json()
        raise CbeVerifyError("Verification did not complete", status=408, body=initial)

    def create_api_key(self, name=None, permissions=None):
        body = {}
        if name:
            body["name"] = name
        if permissions:
            body["permissions"] = permissions
        res = self._request("POST", self.base_url + "/api/api-keys", body=body)
        if res.status_code != 201:
            raise CbeVerifyError(res.json().get("message", "Create failed"),
                                 status=res.status_code, body=self._safe_json(res))
        return res.json()["data"]

    def list_api_keys(self):
        res = self._request("GET", self.base_url + "/api/api-keys")
        return res.json().get("data", [])

    def revoke_api_key(self, key_id):
        res = self._request("DELETE", self.base_url + "/api/api-keys/" + key_id)
        if res.status_code != 200:
            raise CbeVerifyError("Revoke failed", status=res.status_code)

    def _request(self, method, url, body=None, extra_headers=None):
        headers = {"x-api-key": self.api_key, "content-type": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        for attempt in range(self.max_retries + 1):
            try:
                res = self._client.request(method, url, json=body, headers=headers)
                if (res.status_code == 429 or res.status_code >= 500) and attempt < self.max_retries:
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                return res
            except httpx.RequestError as e:
                if attempt < self.max_retries:
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                raise CbeVerifyNetworkError(str(e), cause=e)
        raise RuntimeError("Request failed")

    def _safe_json(self, res):
        try:
            return res.json()
        except Exception:
            return {"text": res.text}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self._client.close()
