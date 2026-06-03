Output aius-auth.gif

Set FontSize 17
Set Width 1000
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"

Env HOME "/tmp/aius-fakehome"
Env AIUS_SKIP_PREFLIGHT "1"
Env AIUS_API_URL "https://api.dev.aius.co/v1"

Hide
Type "export PATH=/tmp/aius-cap/bin:$PATH; clear"
Enter
Show

Type "aius /tmp/aius-demo-proj"
Enter
Sleep 7s
Screenshot aius-auth.png
Sleep 500ms
