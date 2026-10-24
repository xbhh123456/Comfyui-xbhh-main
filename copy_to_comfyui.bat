@echo off
setlocal

rem ===== Source: the folder where this script is located =====
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"

rem ===== Destination: ComfyUI custom_nodes =====
set "DST=D:\xbhh\1\ComfyUI_windows_portable\ComfyUI\custom_nodes\Comfyui-xbhh-main"

echo ==========================================================
echo  SRC : %SRC%
echo  DST : %DST%
echo ==========================================================
echo.

if not exist "D:\xbhh\1\ComfyUI_windows_portable\ComfyUI\custom_nodes" (
    echo [ERROR] Target folder not found:
    echo        D:\xbhh\1\ComfyUI_windows_portable\ComfyUI\custom_nodes
    echo.
    pause
    exit /b 1
)

rem ===== Remove stale bytecode in destination, so ComfyUI won't load old .pyc =====
for /d /r "%DST%" %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d" 2>nul

rem ===== Mirror sync (extra files in destination are deleted) =====
robocopy "%SRC%" "%DST%" /MIR /XD __pycache__ .git .ruff_cache /XF *.pyc copy_to_comfyui.bat /R:1 /W:1 /NFL /NDL /NP /NJH
set "RC=%ERRORLEVEL%"

echo.
if %RC% GEQ 8 (
    echo [FAILED] robocopy exit code: %RC%
    echo          Close ComfyUI and try again ^(files may be locked^).
    echo.
    pause
    exit /b %RC%
)

echo [DONE] Synced to custom_nodes. Restart ComfyUI to take effect.
echo.
pause
endlocal
