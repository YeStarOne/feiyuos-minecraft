# Register FeiyuMC scheduled tasks (server/bot at logon, backup daily 04:30)
$ErrorActionPreference = 'Stop'

$a1 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument 'G:\feiyu-mc\ops\start-hidden.vbs G:\feiyu-mc\ops\start-server.bat'
Register-ScheduledTask -TaskName 'FeiyuMC-Server' -Action $a1 -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force | Out-Null

$a2 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument 'G:\feiyu-mc\ops\start-hidden.vbs G:\feiyu-mc\ops\start-bot.bat'
Register-ScheduledTask -TaskName 'FeiyuMC-Bot' -Action $a2 -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force | Out-Null

$a3 = New-ScheduledTaskAction -Execute 'G:\nodejs\node.exe' -Argument 'G:\feiyu-mc\ops\backup-world.js'
Register-ScheduledTask -TaskName 'FeiyuMC-Backup' -Action $a3 -Trigger (New-ScheduledTaskTrigger -Daily -At 04:30) -Force | Out-Null

Start-ScheduledTask -TaskName 'FeiyuMC-Server'
Start-ScheduledTask -TaskName 'FeiyuMC-Bot'

Get-ScheduledTask -TaskName 'FeiyuMC-*' | Select-Object TaskName, State | Format-Table -HideTableHeaders
