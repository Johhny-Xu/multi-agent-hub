"""Small Windows ConPTY adapter for official CLIs that require a real terminal.

No shell, window, PATH changes, or extra Python packages are needed. Only the
process created by this adapter is owned by the caller.
"""
import ctypes
import os
import queue
import subprocess
import threading
import time
from ctypes import wintypes as w


class _StartupInfo(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR),
                ("lpTitle", w.LPWSTR), ("dwX", w.DWORD), ("dwY", w.DWORD),
                ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD),
                ("dwFillAttribute", w.DWORD), ("dwFlags", w.DWORD),
                ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", ctypes.POINTER(ctypes.c_ubyte)),
                ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class _StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", _StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class _ProcessInfo(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class _Coord(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class _PtyOutput:
    """Consumer stream backed by a dedicated raw-pipe drain thread."""
    def __init__(self):
        self.chunks = queue.Queue()
        self.buffer = bytearray()
        self.eof = False

    def _next(self):
        chunk = self.chunks.get()
        if chunk is None:
            self.eof = True
        else:
            self.buffer.extend(chunk)

    def read(self, size=4096):
        if size == 0:
            return b""
        while not self.buffer and not self.eof:
            self._next()
        count = len(self.buffer) if size < 0 else min(size, len(self.buffer))
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def readline(self):
        while b"\n" not in self.buffer and not self.eof:
            self._next()
        end = self.buffer.find(b"\n")
        count = end + 1 if end >= 0 else len(self.buffer)
        return self.read(count)

    def close(self):
        self.chunks.put(None)


class WindowsPty:
    def __init__(self, argv, cwd, env):
        if os.name != "nt":
            raise OSError("ConPTY is available on Windows only")
        import msvcrt
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        self._k = k
        k.CreatePipe.argtypes = [ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.c_void_p, w.DWORD]
        k.CreatePipe.restype = w.BOOL
        k.CloseHandle.argtypes = [w.HANDLE]
        k.CreatePseudoConsole.argtypes = [_Coord, w.HANDLE, w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
        k.CreatePseudoConsole.restype = ctypes.c_long
        k.ClosePseudoConsole.argtypes = [w.HANDLE]
        k.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
        k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
        k.UpdateProcThreadAttribute.restype = w.BOOL
        k.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
        k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(_ProcessInfo)]
        k.CreateProcessW.restype = w.BOOL
        k.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
        k.GetExitCodeProcess.restype = w.BOOL
        k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
        self._console = w.HANDLE()
        self._close_lock = threading.RLock()
        self._process = None
        self._agenthub_job = None
        self._input = None
        self.stdout = None
        self._drain_thread = None
        ir, iw, or_, ow = w.HANDLE(), w.HANDLE(), w.HANDLE(), w.HANDLE()
        attribute = None
        attribute_ready = False
        try:
            if not k.CreatePipe(ctypes.byref(ir), ctypes.byref(iw), None, 0):
                raise ctypes.WinError(ctypes.get_last_error())
            if not k.CreatePipe(ctypes.byref(or_), ctypes.byref(ow), None, 0):
                raise ctypes.WinError(ctypes.get_last_error())
            hr = k.CreatePseudoConsole(_Coord(160, 32), ir, ow, 0, ctypes.byref(self._console))
            if hr < 0:
                raise OSError(f"CreatePseudoConsole failed: HRESULT 0x{hr & 0xffffffff:08x}")
            size = ctypes.c_size_t()
            k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
            attribute = ctypes.create_string_buffer(size.value)
            if not k.InitializeProcThreadAttributeList(attribute, 1, 0, ctypes.byref(size)):
                raise ctypes.WinError(ctypes.get_last_error())
            attribute_ready = True
            if not k.UpdateProcThreadAttribute(attribute, 0, 0x20016, self._console, ctypes.sizeof(w.HANDLE), None, None):
                raise ctypes.WinError(ctypes.get_last_error())
            si = _StartupInfoEx()
            si.StartupInfo.cb = ctypes.sizeof(si)
            si.lpAttributeList = ctypes.cast(attribute, ctypes.c_void_p)
            pi = _ProcessInfo()
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
            environment = ctypes.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(env.items(), key=lambda item: item[0].upper())) + "\0\0")
            # Avoid copying redirected parent handles into a console child.
            si.StartupInfo.dwFlags = 0x100
            if not k.CreateProcessW(argv[0], command, None, None, False, 0x80000 | 0x400 | 0x4, environment, str(cwd), ctypes.byref(si), ctypes.byref(pi)):
                raise ctypes.WinError(ctypes.get_last_error())
            self.pid = pi.dwProcessId
            self._process = pi.hProcess
            self._handle = int(pi.hProcess)
            from command_runtime import _WindowsJob
            self._agenthub_job = _WindowsJob()
            try:
                self._agenthub_job.attach_and_resume(self)
            finally:
                k.CloseHandle(pi.hThread)
            self._input = iw.value
            iw = w.HANDLE()
            pipe = os.fdopen(msvcrt.open_osfhandle(or_.value, os.O_RDONLY | os.O_BINARY), "rb", buffering=0)
            or_ = w.HANDLE()
            self.stdout = _PtyOutput()
            output = self.stdout
            def drain():
                try:
                    while chunk := pipe.read(4096):
                        output.chunks.put(chunk)
                except OSError:
                    pass
                finally:
                    pipe.close()
                    output.close()
            self._drain_thread = threading.Thread(target=drain, daemon=True)
            self._drain_thread.start()
        except BaseException:
            self.close()
            raise
        finally:
            if attribute_ready:
                k.DeleteProcThreadAttributeList(attribute)
            for handle in (ir, iw, or_, ow):
                if handle.value:
                    k.CloseHandle(handle)

    def poll(self):
        if not self._process:
            return 1
        code = w.DWORD()
        if not self._k.GetExitCodeProcess(self._process, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return None if code.value == 259 else code.value

    def terminate(self):
        if self.poll() is None:
            self._k.TerminateProcess(self._process, 1)

    kill = terminate

    def wait(self, timeout=None):
        deadline = time.monotonic() + timeout if timeout is not None else None
        while self.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired("ConPTY process", timeout)
            time.sleep(0.03)
        return self.poll()

    def close(self):
        with self._close_lock:
            if self._agenthub_job:
                self._agenthub_job.close()
                self._agenthub_job = None
            if self._process:
                self.terminate()
            if self._input:
                self._k.CloseHandle(self._input)
                self._input = None
            # A separate thread continuously drains the raw pipe, including
            # final frames written synchronously by older Windows versions.
            # Closing a raw stream while another thread blocks in read can
            # itself deadlock, so the drain thread owns its handle and closes
            # it after EOF. Consumers read a queue, never the pipe directly.
            if self._console.value:
                self._k.ClosePseudoConsole(self._console)
                self._console = w.HANDLE()
            if self._drain_thread:
                self._drain_thread.join(timeout=2)
                self._drain_thread = None
            if self.stdout:
                self.stdout.close()
            if self._process:
                self._k.CloseHandle(self._process)
                self._process = None


def owned_listener_port(proc):
    """Find one listener belonging to this owned job (including CLI wrappers).

    Only process IDs and TCP metadata are inspected. No vendor auth logs or
    callback payloads are read. Ambiguous listeners deliberately fail closed.
    """
    job = getattr(proc, "_agenthub_job", None)
    if os.name != "nt" or not job or not job.handle:
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    query = kernel.QueryInformationJobObject
    query.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
    query.restype = w.BOOL
    buffer = ctypes.create_string_buffer(65536)
    if not query(job.handle, 3, buffer, len(buffer), None):
        raise ctypes.WinError(ctypes.get_last_error())
    count = int.from_bytes(buffer.raw[4:8], "little")
    width = ctypes.sizeof(ctypes.c_void_p)
    pids = {int.from_bytes(buffer.raw[8 + i * width:8 + (i + 1) * width], "little") for i in range(count)}
    tcp = ctypes.WinDLL("iphlpapi", use_last_error=True).GetExtendedTcpTable
    tcp.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.DWORD), w.BOOL, w.ULONG, ctypes.c_int, w.ULONG]
    tcp.restype = w.DWORD
    ports = set()
    for family, stride, state_offset, port_offset, pid_offset in ((2, 24, 0, 8, 20), (23, 56, 48, 20, 52)):
        size = w.DWORD()
        result = tcp(None, ctypes.byref(size), False, family, 5, 0)
        if result not in (0, 122):
            raise OSError(result, "GetExtendedTcpTable size failed")
        table = ctypes.create_string_buffer(size.value)
        result = tcp(table, ctypes.byref(size), False, family, 5, 0)
        if result:
            raise OSError(result, "GetExtendedTcpTable failed")
        rows = int.from_bytes(table.raw[:4], "little")
        for index in range(rows):
            row = table.raw[4 + index * stride:4 + (index + 1) * stride]
            value = lambda offset: int.from_bytes(row[offset:offset + 4], "little")
            if value(state_offset) == 2 and value(pid_offset) in pids:
                ports.add(int.from_bytes(row[port_offset:port_offset + 2], "big"))
    return next(iter(ports)) if len(ports) == 1 else None
