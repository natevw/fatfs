var TEST_IMAGE;                 // TODO: include these in repo
switch (process.argv[2]) {
    case 'fat12':
        TEST_IMAGE = "/Users/natevw/Desktop/fat-rw.dmg";
        break;
    case 'fat16':
        // TODO: make FAT16 image…
        throw Error("No image available.");
    case 'fat32':
        // created via `diskutil eraseVolume FAT32 "TEST" /dev/disk2`
        TEST_IMAGE = "/Users/natevw/Desktop/fat32small.dmg";
        break;
    case 'exfat':
        TEST_IMAGE = "/Users/natevw/Desktop/exfat.dmg";
        break;
    default:
        throw "Usage: node test [fat12|fat16|fat32|exfat]";
}

var fatfs = require("./index.js"),
    vol = require("./img_volume.js").createDriverSync(TEST_IMAGE),
    fs = fatfs.createFileSystem(vol);

fs.readdir("/", function () {
    
});