Cockpit rsnapshot Plugin

This plugin allows you to manage rsnapshot directly through the Cockpit web interface.
You can start backups, edit the configuration, and view log files - everything conveniently in your browser.
Features

    Start a backup (e.g. rsnapshot daily)

    View and edit the configuration (/etc/rsnapshot.conf)

    View log files (/var/log/rsnapshot)

    Easy integration into Cockpit

Requirements
    Cockpit installed and running

    rsnapshot installed and configured

    Root or sudo rights for rsnapshot commands and to write the configuration

Installation

    Clone the plugin:
bash
git clone https://github.com/sepo83/cockpit-rsnapshot.git
cd cockpit-rsnapshot

Make the script executable:
bash
chmod +x write-config.sh

Set up sudo rights for the Cockpit user:

Create a file /etc/sudoers.d/cockpit-rsnapshot with the following content (adjust the user if necessary):
text
%wheel ALL=(ALL) NOPASSWD: /usr/bin/rsnapshot

    Note: Replace /path/to/your/cockpit-rsnapshot/ with the actual path.

Start in development mode:
    bash
    ./tools/run-dev

    Then access Cockpit in your browser: https://localhost:9090

Usage

    Start a backup:
    Click on "Start Backup" to run an rsnapshot backup (e.g. rsnapshot daily).

    View/edit configuration:
    Click on "View Configuration", edit the file, and save it with "Save Configuration".

    View logs:
    Click on "View Logs" to see the current rsnapshot log.

Security Notes

    The plugin requires elevated privileges (sudo) for some operations.
    Make sure only trusted users have access to Cockpit and this plugin.

    Edit the sudoers file with visudo and carefully check the paths.

Troubleshooting

    Permission issues:
    Check the sudoers configuration and file permissions of write-config.sh.

    No output or errors in the UI:
    Open the browser console (F12) and check for error messages.

    rsnapshot is not running:
    Test the commands first directly in the terminal.

Contribution

Pull Requests, Bug Reports, and Feature Requests are welcome!
License
MIT License