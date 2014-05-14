var TEST_IMAGE = "/Users/natevw/Desktop/fat-rw.dmg";

var fatfs = require("./index.js"),
    vol = require("./img_volume.js").createDriverSync(TEST_IMAGE),
    fs = fatfs.createFileSystem(vol);

fs.readdir("/", function () {
    
});