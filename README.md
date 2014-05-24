# fatfs

A standalone FAT16/FAT32 implementation that takes in a block-access interface and exposes something quite similar to `require('fs')` (i.e. the node.js built-in [Filesystem API](http://nodejs.org/api/fs.html)).

## Installation

`npm install fatfs`

## Example

```js
var fatfs = require('fatfs'),
    fs = fatfs.createFileSystem(exampleDriver);      // see below
fs.stat("autoexec.bat", function (e,stats) {
    if (e) console.error(e);
    else console.log(stats);
});
// TODO: open a file and write to it or something…
```

## API

**TBD**

This will basically try to follow the ['fs' module](http://nodejs.org/api/fs.html) as far as it makes sense.

Expected differences:
- starting with async versions only [or opposite?]
- path will be relative to a single volume, no "mount points" or whatever yet
- therefore, you'll need to create a sub-instance (as it were) of the module
- FAT does not support permissions/ownership/symlinks, so none of that
- not sure if fsync will be meaningful
- streams will be lower priority than "the basics"
- watch/watchFile will be low priority


## "Block driver" API


**NOTE**: this will likely be changing to something like `{readSector,writeSector,flush}` soon


**TBD:** if we're going to support sync methods, we'll need sync versions too…
**TBD:** probably need at least a `.size` (and `.blksize`?)

Basically you just need to provide an object with two methods, `read` and `write`. These should behave like the node.js [fs.read](http://nodejs.org/api/fs.html#fs_fs_read_fd_buffer_offset_length_position_callback) and [fs.write](http://nodejs.org/api/fs.html#fs_fs_write_fd_buffer_offset_length_position_callback) methods. They will *always* be called with an explicit position, so you do not need to keep track.

If you do not provide a `write` method, then `fatfs` will work in readonly mode.

For example:

```js
// NOTE: this assumes image has no partition table
//       …if it did, you'd need to translate positions
var fs = require('fs'),
    fd = fs.openSync("image", 'r+'),
    ro = true;

var exampleDriver = {
    read: fs.read.bind(fs, fd),
    write: (ro) ? fs.write.bind(fs, fd) : null
};
```


## License

© 2014 Nathan Vander Wilt
Funding for this work was provided by Technical Machine, Inc.

Reuse under your choice of:

* [BSD-2-Clause](http://opensource.org/licenses/BSD-2-Clause)
* [Apache 2.0](http://www.apache.org/licenses/LICENSE-2.0.html)