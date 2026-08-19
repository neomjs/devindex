# Drop custom main thread addons into this folder
Example: you create a file here called `MyAddon.mjs`.
Then you can drop it into the `neo-config.json` files inside the root level of your apps
using a 'WS/' prefix.

"mainThreadAddons": ["DragDrop", "Stylesheet", "WS/MyAddon"]