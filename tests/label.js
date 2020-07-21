var fatfs = require("../");
var createDriverSync = require("../img_volume").createDriverSync

const buffer = createDriverSync("tests/label.img")

const fs = fatfs.createFileSystem(buffer, {allowLowercaseNames: true})

fs.createLabel("cidata", () => {})