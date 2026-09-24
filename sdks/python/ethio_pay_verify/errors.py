class CbeVerifyError(Exception):
    def __init__(self, message, status=0, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class CbeVerifyNetworkError(Exception):
    def __init__(self, message, cause=None):
        super().__init__(message)
        self.cause = cause
