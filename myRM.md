mklink /D "C:\Users\92892\.cursor\extensions\cursor-file-navigation2"    "D:\files\using\VSCE\VSCE_Jump_In_One_File\cursor-file-navigation"


如果放到插件目录不成功,可以尝试更改名字



使用方法:在Preferences: Open Keyboard Shortcuts (JSON)中添加下面,并删除所有相关快捷键:

{ "key": "alt+left",  "command": "cursorFileNav.back",    "when": "editorTextFocus" },
{ "key": "alt+right", "command": "cursorFileNav.forward",  "when": "editorTextFocus" }  
  