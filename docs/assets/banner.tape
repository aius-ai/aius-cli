Output aius-banner.gif

Set FontSize 20
Set Width 1100
Set Height 600
Set Padding 28
Set Theme "Catppuccin Mocha"

Env HOME "/tmp/aius-fakehome"

Hide
Type "export PATH=/tmp/aius-cap/bin:$PATH; export PS1=''; clear"
Enter
Show

Type "aius --help 2>&1 | head -16"
Enter
Sleep 1500ms
Screenshot aius-banner.png
Sleep 300ms
