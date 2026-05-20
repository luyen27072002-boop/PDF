@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo Local PDF Editor - setup and run
echo ========================================

if not exist "requirements.txt" (
  echo ERROR: requirements.txt khong nam trong thu muc nay.
  echo Hay mo dung thu muc project, thu muc co file requirements.txt va app\main.py.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Dang tao virtual environment...
  py -3 -m venv .venv
  if errorlevel 1 (
    python -m venv .venv
  )
)

echo Dang cai thu vien...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo Cai thu vien bi loi.
  pause
  exit /b 1
)

echo.
echo Server dang chay tai: http://127.0.0.1:8000
echo Nhan Ctrl+C de tat server.
echo.
".venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
pause
