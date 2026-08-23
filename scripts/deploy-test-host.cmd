@echo off
title Deploy TraceAI test host (192.168.1.185)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-test-host.ps1"
if errorlevel 1 pause
