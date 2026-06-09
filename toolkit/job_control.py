from typing import Literal


JobExitStatus = Literal["stopped", "queued"]


class JobControlExit(Exception):
    def __init__(self, status: JobExitStatus, info: str):
        super().__init__(info)
        self.status = status
        self.info = info
