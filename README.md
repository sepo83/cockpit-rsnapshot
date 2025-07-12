Cockpit rsnapshot Plugin

Dieses Plugin ermöglicht die Verwaltung von rsnapshot direkt über das Cockpit-Webinterface.
Du kannst Backups starten, die Konfiguration bearbeiten und Logdateien einsehen – alles bequem im Browser.
Features

    Backup starten (z.B. rsnapshot daily)

    Konfiguration anzeigen und bearbeiten (/etc/rsnapshot.conf)

    Logdateien anzeigen (/var/log/rsnapshot)

    Einfache Integration in Cockpit

Voraussetzungen

    Cockpit installiert und lauffähig

    rsnapshot installiert und konfiguriert

    Root- oder Sudo-Rechte für rsnapshot-Befehle und zum Schreiben der Konfiguration

Installation

    Plugin klonen:

bash
git clone https://github.com/sepo83/cockpit-rsnapshot.git
cd cockpit-rsnapshot

Skript ausführbar machen:

bash
chmod +x write-config.sh

Sudo-Rechte für Cockpit-Benutzer einrichten:

Erstelle eine Datei /etc/sudoers.d/cockpit-rsnapshot mit folgendem Inhalt (passe ggf. den Benutzer an):

text
%wheel ALL=(ALL) NOPASSWD: /pfad/zu/deinem/cockpit-rsnapshot/write-config.sh
%wheel ALL=(ALL) NOPASSWD: /usr/bin/rsnapshot

    Hinweis: Ersetze /pfad/zu/deinem/cockpit-rsnapshot/ durch den tatsächlichen Pfad.

Im Entwicklungsmodus starten:

    bash
    ./tools/run-dev

    Rufe dann Cockpit im Browser auf: https://localhost:9090

Nutzung

    Backup starten:
    Klicke auf „Backup starten“, um ein rsnapshot-Backup (z.B. daily) auszuführen.

    Konfiguration anzeigen/bearbeiten:
    Klicke auf „Konfiguration anzeigen“, bearbeite die Datei und speichere mit „Konfiguration speichern“.

    Log anzeigen:
    Klicke auf „Log anzeigen“, um das aktuelle rsnapshot-Log einzusehen.

Sicherheitshinweise

    Das Plugin benötigt erhöhte Rechte (sudo) für einige Operationen.
    Stelle sicher, dass nur vertrauenswürdige Benutzer Zugriff auf Cockpit und dieses Plugin haben.

    Bearbeite die Sudoers-Datei mit visudo und prüfe die Pfade sorgfältig.

Fehlerbehebung

    Berechtigungsprobleme:
    Prüfe die Sudoers-Konfiguration und die Dateiberechtigungen von write-config.sh.

    Keine Ausgabe oder Fehler im UI:
    Öffne die Browser-Konsole (F12) und prüfe die Fehlermeldungen.

    rsnapshot läuft nicht:
    Teste die Befehle zuerst direkt im Terminal.

Mitwirken

Pull Requests, Bug Reports und Feature-Wünsche sind willkommen!
Lizenz

MIT License