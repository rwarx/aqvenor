; Installer guard rails for Aqvenor.
;
; electron-builder packs the whole app into a 7z payload and unpacks it into
; $PLUGINSDIR, which lives on the drive that hosts $TEMP. When that drive runs
; out of space the NSIS script fails silently mid-copy: the app installs with
; some DLLs and the sidecar missing, and the user is left with a grey window
; that looks like a broken product. A disk that is almost full also leaves the
; unpacked app itself short on space.
;
; This include checks free space before the first byte is unpacked:
;   - the $TEMP drive needs about 800 MB (114 MB payload, ~450 MB unpacked,
;     plus slack);
;   - the installation drive needs about 600 MB (the unpacked app).
; The checks fail open (an exotic TEMP location or a failed API call never
; blocks the installer) and the refusal messages are localized for every
; language the installer offers.

!include "FileFunc.nsh"
!include "WordFunc.nsh"

LangString aqvenorSpaceTemp 1033 "There is not enough free disk space to install Aqvenor.$\r$\n$\r$\nThe installer needs about 800 MB of temporary space on the @T@ drive and about 600 MB on the drive it will install to.$\r$\n$\r$\nFree up space on @T@ (or move your TEMP folder to a larger drive) and run the installer again."
LangString aqvenorSpaceTemp 1049 "Недостаточно свободного места для установки Aqvenor.$\r$\n$\r$\nУстановщику требуется около 800 МБ временного места на диске @T@ и около 600 МБ на диске, куда будет выполнена установка.$\r$\n$\r$\nОсвободите место на @T@ (или перенесите папку TEMP на диск большего объёма) и запустите установщик снова."
LangString aqvenorSpaceTemp 1031 "Für die Installation von Aqvenor ist nicht genug freier Speicherplatz vorhanden.$\r$\n$\r$\nDas Installationsprogramm benötigt rund 800 MB temporären Platz auf dem Laufwerk @T@ und rund 600 MB auf dem Installationslaufwerk.$\r$\n$\r$\nGeben Sie Speicherplatz auf @T@ frei (oder verlegen Sie den TEMP-Ordner auf ein größeres Laufwerk) und starten Sie das Installationsprogramm erneut."
LangString aqvenorSpaceTemp 3082 "No hay suficiente espacio libre para instalar Aqvenor.$\r$\n$\r$\nEl instalador necesita unos 800 MB de espacio temporal en la unidad @T@ y unos 600 MB en la unidad de instalación.$\r$\n$\r$\nLibere espacio en @T@ (o mueva la carpeta TEMP a una unidad más grande) y vuelva a ejecutar el instalador."
LangString aqvenorSpaceTemp 1036 "Il n'y a pas assez d'espace libre pour installer Aqvenor.$\r$\n$\r$\nLe programme d'installation a besoin d'environ 800 Mo d'espace temporaire sur le lecteur @T@ et d'environ 600 Mo sur le lecteur d'installation.$\r$\n$\r$\nLibérez de l'espace sur @T@ (ou déplacez votre dossier TEMP vers un disque plus grand), puis relancez le programme d'installation."
LangString aqvenorSpaceTemp 1040 "Non c'è abbastanza spazio su disco per installare Aqvenor.$\r$\n$\r$\nIl programma di installazione richiede circa 800 MB di spazio temporaneo sull'unità @T@ e circa 600 MB sull'unità di installazione.$\r$\n$\r$\nLibera spazio su @T@ (o sposta la cartella TEMP su un'unità più grande) e avvia di nuovo il programma di installazione."
LangString aqvenorSpaceTemp 1041 "Aqvenor をインストールするには空き容量が足りません。$\r$\n$\r$\nインストーラーには一時領域として @T@ ドライブに約 800 MB、インストール先ドライブに約 600 MB が必要です。$\r$\n$\r$\n@T@ の空き容量を確保する（または TEMP フォルダーを大きなドライブへ移す）か、その後にもう一度インストーラーを実行してください。"
LangString aqvenorSpaceTemp 1042 "Aqvenor를 설치하기에 여유 공간이 부족합니다.$\r$\n$\r$\n설치 프로그램에는 @T@ 드라이브에 약 800 MB의 임시 공간과, 설치 대상 드라이브에 약 600 MB가 필요합니다.$\r$\n$\r$\n@T@의 공간을 확보하거나(또는 TEMP 폴더를 더 큰 드라이브로 옮긴 후) 설치 프로그램을 다시 실행하세요."
LangString aqvenorSpaceTemp 1046 "Não há espaço livre suficiente para instalar o Aqvenor.$\r$\n$\r$\nO instalador precisa de cerca de 800 MB de espaço temporário na unidade @T@ e cerca de 600 MB na unidade de instalação.$\r$\n$\r$\nLibere espaço em @T@ (ou mova a pasta TEMP para uma unidade maior) e execute o instalador novamente."
LangString aqvenorSpaceTemp 1055 "Aqvenor kurulumu için yeterli boş disk alanı yok.$\r$\n$\r$\nKurulum, @T@ sürücüsünde yaklaşık 800 MB geçici alana ve kurulum sürücüsünde yaklaşık 600 MB alana ihtiyaç duyar.$\r$\n$\r$\n@T@ üzerinde alan açın (veya TEMP klasörünü daha büyük bir sürücüye taşıyın) ve kurulumu yeniden çalıştırın."
LangString aqvenorSpaceTemp 2052 "没有足够的可用磁盘空间来安装 Aqvenor。$\r$\n$\r$\n安装程序需要临时盘 @T@ 约 800 MB、安装目标盘约 600 MB 的空间。$\r$\n$\r$\n请先在 @T@ 上释放空间（或将 TEMP 文件夹移到更大的磁盘），然后重新运行安装程序。"

LangString aqvenorSpaceDrive 1033 "There is not enough free disk space on the installation drive @D@.$\r$\n$\r$\nThe installer needs about 600 MB. Free up space on @D@ and run the installer again."
LangString aqvenorSpaceDrive 1049 "Недостаточно свободного места на диске установки @D@.$\r$\n$\r$\nУстановщику требуется около 600 МБ. Освободите место на @D@ и запустите установщик снова."
LangString aqvenorSpaceDrive 1031 "Nicht genug freier Speicherplatz auf dem Installationslaufwerk @D@.$\r$\n$\r$\nDas Installationsprogramm benötigt rund 600 MB. Geben Sie Speicherplatz auf @D@ frei und starten Sie das Installationsprogramm erneut."
LangString aqvenorSpaceDrive 3082 "No hay suficiente espacio libre en la unidad de instalación @D@.$\r$\n$\r$\nEl instalador necesita unos 600 MB. Libere espacio en @D@ y vuelva a ejecutar el instalador."
LangString aqvenorSpaceDrive 1036 "Espace insuffisant sur le lecteur d'installation @D@.$\r$\n$\r$\nLe programme d'installation a besoin d'environ 600 Mo. Libérez de l'espace sur @D@, puis relancez le programme."
LangString aqvenorSpaceDrive 1040 "Spazio insufficiente sull'unità di installazione @D@.$\r$\n$\r$\nIl programma di installazione richiede circa 600 MB. Libera spazio su @D@ e avvia di nuovo il programma."
LangString aqvenorSpaceDrive 1041 "インストール先ドライブ @D@ に十分な空き容量がありません。$\r$\n$\r$\nインストーラーには約 600 MB が必要です。@D@ の空き容量を確保してから、もう一度実行してください。"
LangString aqvenorSpaceDrive 1042 "설치 대상 드라이브 @D@에 여유 공간이 부족합니다.$\r$\n$\r$\n설치 프로그램에는 약 600 MB가 필요합니다. @D@의 공간을 확보한 후 다시 실행하세요."
LangString aqvenorSpaceDrive 1046 "Espaço insuficiente na unidade de instalação @D@.$\r$\n$\r$\nO instalador precisa de cerca de 600 MB. Libere espaço em @D@ e execute novamente."
LangString aqvenorSpaceDrive 1055 "Kurulum sürücüsü @D@ üzerinde yeterli boş alan yok.$\r$\n$\r$\nKurulum yaklaşık 600 MB gerektirir. @D@ üzerinde alan açın ve yeniden çalıştırın."
LangString aqvenorSpaceDrive 2052 "安装目标盘 @D@ 的剩余空间不足。$\r$\n$\r$\n安装程序需要约 600 MB。请先在 @D@ 上释放空间，然后重新运行。"

!macro customInit
  ; The PLUGINSDIR lives on the drive that hosts $TEMP: refuse early rather
  ; than half-install silently. Plug the root path back into slash form the
  ; API expects.
  ${GetRoot} "$TEMP" $R5
  StrCpy $R5 "$R5\"
  System::Call 'kernel32::GetDiskFreeSpaceExW(t "$R5", *l .r1, *l .r2, *l .r3) i .r4'
  IntCmp $4 1 +1 aqvenorSpaceTempDone aqvenorSpaceTempDone
  System::Int64Op $1 < 800000000
  Pop $R6
  IntCmp $R6 1 +1 aqvenorSpaceTempDone aqvenorSpaceTempDone
  ${GetRoot} "$TEMP" $R8
  StrCpy $R7 "$(aqvenorSpaceTemp)"
  ${WordReplace} "$R7" "@T@" "$R8" "+1" $R7
  ${WordReplace} "$R7" "@T@" "$R8" "+1" $R7
  MessageBox MB_ICONSTOP "$R7"
  Quit
  aqvenorSpaceTempDone:

  ; The unpacked app is about 600 MB on the installation drive. $INSTDIR may
  ; still be empty at this point; only check it when there is a real path.
  StrCmp "$INSTDIR" "" aqvenorSpaceDriveDone 0
  ${GetRoot} "$INSTDIR" $R5
  StrCpy $R5 "$R5\"
  System::Call 'kernel32::GetDiskFreeSpaceExW(t "$R5", *l .r1, *l .r2, *l .r3) i .r4'
  IntCmp $4 1 +1 aqvenorSpaceDriveDone aqvenorSpaceDriveDone
  System::Int64Op $1 < 600000000
  Pop $R6
  IntCmp $R6 1 +1 aqvenorSpaceDriveDone aqvenorSpaceDriveDone
  ${GetRoot} "$INSTDIR" $R8
  StrCpy $R7 "$(aqvenorSpaceDrive)"
  ${WordReplace} "$R7" "@D@" "$R8" "+1" $R7
  ${WordReplace} "$R7" "@D@" "$R8" "+1" $R7
  MessageBox MB_ICONSTOP "$R7"
  Quit
  aqvenorSpaceDriveDone:
!macroend
