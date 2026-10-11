import os
import shutil
import subprocess
import time

exe_path = os.path.expanduser(r"~\.codeartsdoer\CodeArts_Agent\AgentKernel_Vscode_26_9_501_1_0_0-1151846206572736.exe")
bak_path = exe_path + ".bak"
patched_path = exe_path + ".patched"

print(f"Reading {exe_path}...")
with open(exe_path, "rb") as f:
    data = f.read()

s_old = b'{server:X,type:Q.constructor.name}'
s_new = b'{server:X,type:typeof Q}          '

assert len(s_old) == len(s_new), "Lengths must match!"
assert data.count(s_old) == 1, f"Expected 1 occurrence, found {data.count(s_old)}"

if not os.path.exists(bak_path):
    print(f"Creating backup at {bak_path}...")
    shutil.copy2(exe_path, bak_path)

print(f"Writing patched binary to {patched_path}...")
patched_data = data.replace(s_old, s_new)
assert len(patched_data) == len(data), "File size must not change!"

with open(patched_path, "wb") as f:
    f.write(patched_data)

print("Killing running AgentKernel processes...")
try:
    subprocess.run(["taskkill", "/F", "/IM", "AgentKernel*"], capture_output=True)
except Exception as e:
    print("taskkill output:", e)

time.sleep(1)

print("Replacing exe with patched version...")
shutil.move(patched_path, exe_path)
print("Patch successfully applied!")
