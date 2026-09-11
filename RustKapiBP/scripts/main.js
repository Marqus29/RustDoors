import { world, system, ItemStack } from "@minecraft/server";
import { ModalFormData, ActionFormData } from "@minecraft/server-ui";

const KEYCARD_ID = "rust:keycard";
const BLANK_KEYCARD_ID = "rust:blank_keycard";
const WORKBENCH_ID = "rust:rfid_workbench";
const MAX_DOOR_HP = 1000;
const DEFAULT_DOOR_TIMER = 3;

const CUSTOM_SOUND_OPEN = "rust.door_open";
const CUSTOM_SOUND_CLOSE = "rust.door_close";

const activeSessions = new Set();
const failedAttempts = new Map();
const shockCooldowns = new Map();
const activeSpycams = new Map();

// -------------------------------------------------------------
// CACHE (ÖNBELLEK) SİSTEMİ VE OPTİMİZASYON
// -------------------------------------------------------------
const doorCache = new Map();

system.run(() => {
    const allKeys = world.getDynamicPropertyIds().filter(k => k.startsWith("d_"));
    for (const key of allKeys) {
        try {
            const raw = world.getDynamicProperty(key);
            if (raw) {
                const data = JSON.parse(raw);
                const parts = key.split("_");
                let dim, x, y, z;
                
                if (parts.length === 5) {
                    dim = "minecraft:" + parts[1];
                    x = parseInt(parts[2]); y = parseInt(parts[3]); z = parseInt(parts[4]);
                } else if (parts.length === 4) {
                    dim = "minecraft:overworld";
                    x = parseInt(parts[1]); y = parseInt(parts[2]); z = parseInt(parts[3]);
                } else continue;
                
                doorCache.set(key, { dim, x, y, z, data });
            }
        } catch(e) {}
    }
});

function isBaseDoor(typeId) {
    return typeId && typeId.startsWith("rust:bunker_door") && !typeId.endsWith("_top");
}

function isTopDoor(typeId) {
    return typeId && typeId.startsWith("rust:bunker_door") && typeId.endsWith("_top");
}

function isAnyBunkerDoor(typeId) {
    return typeId && typeId.startsWith("rust:bunker_door");
}

system.runInterval(() => {
    const now = Date.now();
    for (const [key, unlockTime] of shockCooldowns.entries()) {
        if (now > unlockTime) {
            shockCooldowns.delete(key);
            failedAttempts.delete(key);
        }
    }
}, 1200);

function getDoorKey(lowerBlock) {
    return `d_${lowerBlock.dimension.id.replace("minecraft:", "")}_${lowerBlock.x}_${lowerBlock.y}_${lowerBlock.z}`;
}

function getDoorData(lowerBlock) {
    const primaryKey = getDoorKey(lowerBlock);
    if (doorCache.has(primaryKey)) return { key: primaryKey, data: doorCache.get(primaryKey).data };

    const adjacent = findAdjacentDoor(lowerBlock);
    if (adjacent && adjacent.lowerBlock) {
        const adjKey = getDoorKey(adjacent.lowerBlock);
        if (doorCache.has(adjKey)) return { key: adjKey, data: doorCache.get(adjKey).data };
    }

    return { key: primaryKey, data: null };
}

function saveDoorData(key, data, syncAdjacent = true) {
    if (!data) {
        world.setDynamicProperty(key, undefined);
        doorCache.delete(key);
    } else {
        world.setDynamicProperty(key, JSON.stringify(data));
        const parts = key.split("_");
        let dim, x, y, z;
        if (parts.length === 5) {
            dim = "minecraft:" + parts[1];
            x = parseInt(parts[2]); y = parseInt(parts[3]); z = parseInt(parts[4]);
        } else if (parts.length === 4) {
            dim = "minecraft:overworld";
            x = parseInt(parts[1]); y = parseInt(parts[2]); z = parseInt(parts[3]);
        }
        doorCache.set(key, { dim, x, y, z, data });

        if (syncAdjacent && dim) {
            try {
                const dimension = world.getDimension(dim);
                const currentBlock = dimension.getBlock({ x, y, z });
                if (currentBlock) {
                    const adjacent = findAdjacentDoor(currentBlock);
                    if (adjacent && adjacent.lowerBlock) {
                        const adjKey = getDoorKey(adjacent.lowerBlock);
                        saveDoorData(adjKey, data, false);
                    }
                }
            } catch (e) {}
        }
    }
}

function isRedstoneComponent(typeId) {
    return (
        typeId === "minecraft:lever" ||
        typeId.includes("button") ||
        typeId.includes("pressure_plate") ||
        typeId.includes("redstone") ||
        typeId.includes("repeater") ||
        typeId.includes("comparator") ||
        typeId.includes("observer") ||
        typeId.includes("tripwire_hook") ||
        typeId === "minecraft:target"
    );
}

function getDoorBlocks(block) {
    try {
        if (isTopDoor(block.typeId)) {
            const lowerBlock = block.below();
            return { lowerBlock, upperBlock: block, isUpper: true };
        } else if (isBaseDoor(block.typeId)) {
            const upperBlock = block.above();
            return { lowerBlock: block, upperBlock, isUpper: false };
        }
    } catch (e) {}
    return { lowerBlock: block, upperBlock: null, isUpper: false };
}

function findAdjacentDoor(lowerBlock) {
    const directions = [
        { x: 1, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: -1 }
    ];

    for (const d of directions) {
        try {
            const neighbor = lowerBlock.dimension.getBlock({
                x: lowerBlock.x + d.x,
                y: lowerBlock.y,
                z: lowerBlock.z + d.z
            });

            if (neighbor && neighbor.typeId === lowerBlock.typeId) {
                return getDoorBlocks(neighbor);
            }
        } catch (e) {}
    }
    return null;
}

function isPlayerOwner(doorData, playerId) {
    return doorData && doorData.owner === playerId;
}

function isPlayerCoOwner(doorData, playerId) {
    return doorData && doorData.coOwners && doorData.coOwners.some((c) => c.id === playerId);
}

function isPlayerManager(doorData, playerId) {
    return isPlayerOwner(doorData, playerId) || isPlayerCoOwner(doorData, playerId);
}

function isPlayerAuthorized(doorData, playerId) {
    if (!doorData) return false;
    if (isPlayerManager(doorData, playerId)) return true;
    if (doorData.whitelist && doorData.whitelist.some((m) => m.id === playerId)) return true;
    return false;
}

function authorizePlayer(doorData, playerId, playerName) {
    if (!doorData.whitelist) doorData.whitelist = [];
    if (!doorData.whitelist.some((m) => m.id === playerId)) {
        doorData.whitelist.push({ id: playerId, name: playerName });
    }
}

function saveOutsideDirection(doorData, lowerBlock, playerLoc) {
    const dx = playerLoc.x - (lowerBlock.x + 0.5);
    const dz = playerLoc.z - (lowerBlock.z + 0.5);

    const signX = dx >= 0 ? 1 : -1;
    const signZ = dz >= 0 ? 1 : -1;

    if (Math.abs(dx) > Math.abs(dz)) {
        doorData.dir = `x:${signX}`;
    } else {
        doorData.dir = `z:${signZ}`;
    }
}

function isPlayerInside(player, lowerBlock, doorData) {
    if (!doorData || !doorData.dir) return false;

    const [axis, signStr] = doorData.dir.split(":");
    const sign = parseFloat(signStr);
    const pLoc = player.location;

    if (axis === "x") {
        const diff = (pLoc.x - (lowerBlock.x + 0.5)) * sign;
        return diff < -0.3;
    } else {
        const diff = (pLoc.z - (lowerBlock.z + 0.5)) * sign;
        return diff < -0.3;
    }
}

function isDoorwayBlocked(dimension, lowerBlock, adjLowerBlock) {
    const positions = [lowerBlock.location];
    if (adjLowerBlock) positions.push(adjLowerBlock.location);

    for (const pos of positions) {
        try {
            const entities = dimension.getEntities({
                location: { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 },
                maxDistance: 0.95
            });
            if (entities.length > 0) return true;
        } catch (e) {}
    }
    return false;
}

function findNearbyLockedDoor(dimension, pos, radius = 2) {
    const radiusSq = radius * radius;
    for (const [key, cache] of doorCache.entries()) {
        if (cache.dim !== dimension.id) continue;
        if (!cache.data || !cache.data.pin) continue; 
        
        const dx = pos.x - cache.x, dy = pos.y - cache.y, dz = pos.z - cache.z;
        if (dx*dx + dy*dy + dz*dz <= radiusSq) {
            try {
                const lowerBlock = dimension.getBlock({ x: cache.x, y: cache.y, z: cache.z });
                if (lowerBlock && lowerBlock.typeId.startsWith("rust:bunker_door")) {
                    return { lowerBlock, key, data: cache.data };
                }
            } catch(e) {}
        }
    }
    return null;
}

function notifyOwner(ownerId, message, title = null, subtitle = null) {
    if (!ownerId) return;

    for (const p of world.getAllPlayers()) {
        if (p.id === ownerId) {
            p.sendMessage(message);
            p.playSound("mob.warden.heartbeat", { pitch: 1.2, volume: 1.0 });
            p.playSound("ambient.weather.thunder", { pitch: 1.0, volume: 0.8 });

            if (title) {
                p.onScreenDisplay.setTitle(title);
                if (subtitle) p.onScreenDisplay.setSubtitle(subtitle);
            }
            break;
        }
    }
}

function triggerRedstoneShock(player, redstoneBlock, doorBlock, ownerId) {
    player.applyDamage(6);
    player.playSound("ambient.weather.thunder", { pitch: 1.8, volume: 1.0 });

    try {
        player.dimension.spawnParticle("minecraft:electric_spark_particle", {
            x: player.location.x, y: player.location.y + 1, z: player.location.z
        });
    } catch (e) {}

    player.onScreenDisplay.setActionBar("§c[!] ELEKTRİK AKIMI! Yetkisiz Redstone Sabotajı Engellendi!");

    if (redstoneBlock) {
        system.run(() => {
            try { redstoneBlock.dimension.runCommand(`setblock ${redstoneBlock.x} ${redstoneBlock.y} ${redstoneBlock.z} air destroy`); }
            catch (e) { try { redstoneBlock.setType("minecraft:air"); } catch (err) {} }
        });
    }

    notifyOwner(
        ownerId,
        `§4§l[SABOTAJ ALARMI] §c${player.nameTag} kapına redstone bağlamaya çalıştı!\n§eKonum: §fX: ${doorBlock.x}, Y: ${doorBlock.y}, Z: ${doorBlock.z}`,
        "§4§lREDSTONE SABOTAJI!",
        `§c${player.nameTag} şalteri patlatıldı!`
    );
}

function releasePlayer(player) {
    system.runTimeout(() => { activeSessions.delete(player.id); }, 10);
}

// -------------------------------------------------------------
// MAZGAL KAMERASI
// -------------------------------------------------------------
function startSpyCam(player, lowerBlock, doorData) {
    if (activeSpycams.has(player.id)) { stopSpyCam(player); return; }

    const dirProp = doorData.dir || "z:1";
    const [axis, signStr] = dirProp.split(":");
    const sign = parseFloat(signStr);

    let camX = lowerBlock.x + 0.5, camY = lowerBlock.y + 1.4, camZ = lowerBlock.z + 0.5;
    let faceX = camX, faceY = camY, faceZ = camZ;

    if (axis === "x") { camX += sign * 1.1; faceX += sign * 8.0; }
    else { camZ += sign * 1.1; faceZ += sign * 8.0; }

    const originLoc = { x: player.location.x, y: player.location.y, z: player.location.z };

    try {
        player.runCommandAsync(`camera @s set minecraft:free ease 0.2 linear pos ${camX.toFixed(2)} ${camY.toFixed(2)} ${camZ.toFixed(2)} facing ${faceX.toFixed(2)} ${faceY.toFixed(2)} ${faceZ.toFixed(2)}`)
            .then(() => {
                player.playSound("random.click", { pitch: 1.8, volume: 0.8 });
                player.onScreenDisplay.setActionBar("§e[MAZGAL] §7Dışarısı gözetleniyor. Hareket (WASD) kapatır.");

                const runId = system.runInterval(() => {
                    if (!player.isValid()) { stopSpyCam(player); return; }
                    const distSq = (player.location.x - originLoc.x) ** 2 + (player.location.z - originLoc.z) ** 2;
                    if (distSq > 0.04) stopSpyCam(player);
                }, 3);

                activeSpycams.set(player.id, { runId, player });
            }).catch(() => { player.onScreenDisplay.setActionBar("§c[!] Sunucu kamera kullanımına izin vermiyor!"); });
    } catch (e) { player.onScreenDisplay.setActionBar("§c[!] Kamera komutu çalıştırılamadı."); }
}

function stopSpyCam(player) {
    if (!activeSpycams.has(player.id)) return;
    system.clearRun(activeSpycams.get(player.id).runId);
    activeSpycams.delete(player.id);
    try { player.runCommandAsync(`camera @s clear`).catch(() => {}); } catch (e) {}
    player.onScreenDisplay.setActionBar("§c[!] Mazgal kapatıldı.");
}

world.afterEvents.entityHurt.subscribe((event) => {
    if (event.hurtEntity.typeId === "minecraft:player" && activeSpycams.has(event.hurtEntity.id)) {
        stopSpyCam(event.hurtEntity);
        event.hurtEntity.sendMessage("§c[!] Hasar aldığın için mazgal kamerası güvenlik sebebiyle kapatıldı!");
    }
});

function spawnDoorLaserScan(dimension, lowerBlock, success = true) {
    const particle = success ? "minecraft:villager_happy" : "minecraft:villager_angry";
    for (const h of [0.2, 0.7, 1.2, 1.7, 2.0]) {
        try { dimension.spawnParticle(particle, { x: lowerBlock.x + 0.5, y: lowerBlock.y + h, z: lowerBlock.z + 0.5 }); } catch (e) {}
    }
}

function findHeldItem(player, itemId) {
    try {
        const invItem = player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex);
        if (invItem && invItem.typeId === itemId) return { item: invItem, slot: player.selectedSlotIndex, isOffhand: false };
        const offItem = player.getComponent("minecraft:equippable")?.getEquipment("Offhand");
        if (offItem && offItem.typeId === itemId) return { item: offItem, slot: -1, isOffhand: true };
    } catch (e) {}
    return null;
}

function findItemInInventory(player, itemId) {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return null;
    for (let i = 0; i < container.size; i++) {
        const it = container.getItem(i);
        if (it && it.typeId === itemId) return { slot: i, item: it };
    }
    return null;
}

// -------------------------------------------------------------
// MERKEZİ TEZGAH (WORKBENCH): EĞİLEREK SAĞ TIK İLE KAPI LİSTESİ
// -------------------------------------------------------------
function openAllDoorsAndCardsMenu(player) {
    player.playSound("random.click", { pitch: 1.2, volume: 0.8 });
    const processedKeys = new Set();
    const myDoors = [];

    for (const [key, cache] of doorCache.entries()) {
        if (!cache.data || !isPlayerOwner(cache.data, player.id)) continue;
        if (processedKeys.has(key)) continue;

        let isDouble = false;
        try {
            const dim = world.getDimension(cache.dim);
            const block = dim.getBlock({ x: cache.x, y: cache.y, z: cache.z });
            if (block) {
                const adj = findAdjacentDoor(block);
                if (adj && adj.lowerBlock) {
                    const adjKey = getDoorKey(adj.lowerBlock);
                    processedKeys.add(adjKey);
                    isDouble = true;
                }
            }
        } catch (e) {}

        processedKeys.add(key);
        myDoors.push({ key, isDouble, ...cache });
    }

    const form = new ActionFormData().title("§8[MERKEZI GUVENLIK PANELI]§r");

    if (myDoors.length === 0) {
        form.body("§7Ağda sana ait aktif bir sığınak kapısı bulunamadı.");
        form.button("Kapat", "textures/ui/cancel");
        form.show(player).then(() => releasePlayer(player)).catch(() => releasePlayer(player));
        return;
    }

    form.body(`§e${myDoors.length}§7 adet kapı ağda aktif.\nYönetmek istediğin kapıyı seç:`);
    for (const d of myDoors) {
        const doorName = d.data.name || `Kapı [${d.x}, ${d.y}, ${d.z}]`;
        const doubleTag = d.isDouble ? " §a[ÇİFT]" : "";
        const cardCount = (d.data.cards || []).length;
        form.button(`§0${doorName}${doubleTag}\n§8Aktif Kart: ${cardCount}`);
    }
    form.button("§8<< Kapat", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled || res.selection >= myDoors.length) {
            releasePlayer(player);
            return;
        }
        const selectedDoor = myDoors[res.selection];
        system.run(() => {
            openDoorManagementMenu(player, selectedDoor);
        });
    }).catch(() => releasePlayer(player));
}

function openDoorManagementMenu(player, doorObj) {
    player.playSound("random.click", { pitch: 1.2, volume: 0.8 });
    const doorName = doorObj.data.name || `Kapı [${doorObj.x}, ${doorObj.y}, ${doorObj.z}]`;
    const cardCount = (doorObj.data.cards || []).length;

    new ActionFormData()
        .title(`§8[${doorName}]§r`)
        .body(`§7Kapı Tipi: ${doorObj.isDouble ? "§aÇiftli Bunker Kapısı" : "§7Tekli Kapı"}\n§7PIN: §e${doorObj.data.pin}\n§7Tanımlı RFID Kart: §e${cardCount} adet\n\nYapmak istediğin işlemi seç:`)
        .button("§2[+] Bu Kapıya Yeni RFID Kart Bas\n§8(1 Boş Kart Gerekir)", "textures/items/keycard")
        .button("§1[-] Kayıtlı Kartları Yönet / İptal Et", "textures/items/paper")
        .button("§8<< Kapı Listesine Dön", "textures/ui/cancel")
        .show(player).then((res) => {
            if (res.canceled || res.selection === 2) {
                system.run(() => openAllDoorsAndCardsMenu(player));
                return;
            }

            if (res.selection === 0) {
                system.run(() => promptEncodeCardOnWorkbench(player, doorObj));
            } else if (res.selection === 1) {
                system.run(() => openCardManagerMenu(player, doorObj.key, doorObj.data, null, doorObj));
            }
        }).catch(() => releasePlayer(player));
}

function promptEncodeCardOnWorkbench(player, doorObj) {
    const blankFound = findItemInInventory(player, BLANK_KEYCARD_ID);
    if (!blankFound) {
        player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
        player.onScreenDisplay.setActionBar("§c[!] Envanterinde Boş RFID Kartı (rust:blank_keycard) yok!");
        system.run(() => openDoorManagementMenu(player, doorObj));
        return;
    }

    const doorName = doorObj.data.name || `Kapı [${doorObj.x}, ${doorObj.y}, ${doorObj.z}]`;

    new ModalFormData()
        .title("§2[KART KODLAMA PROTOKOLU]§r")
        .textField(`Ait Olduğu Kapı:\n§e${doorName}§r\n\nKarta atanacak yetkili ismi/etiketi:`, "Örn: Depocu Ahmet", player.nameTag)
        .show(player).then((res) => {
            if (res.canceled) {
                system.run(() => openDoorManagementMenu(player, doorObj));
                return;
            }

            const holderLabel = (res.formValues[0] || player.nameTag).trim();
            const container = player.getComponent("minecraft:inventory")?.container;
            const currentBlank = container?.getItem(blankFound.slot);

            if (!container || !currentBlank || currentBlank.typeId !== BLANK_KEYCARD_ID) {
                player.sendMessage("§c[!] Boş kart envanterde doğrulanamadı.");
                releasePlayer(player);
                return;
            }

            if (currentBlank.amount > 1) {
                currentBlank.amount -= 1;
                container.setItem(blankFound.slot, currentBlank);
            } else {
                container.setItem(blankFound.slot, null);
            }

            const cardId = "c_" + Date.now().toString(36);
            if (!doorObj.data.cards) doorObj.data.cards = [];
            doorObj.data.cards.push({ id: cardId, h: holderLabel, c: player.nameTag });
            saveDoorData(doorObj.key, doorObj.data, true);

            try {
                const encodedCard = new ItemStack(KEYCARD_ID, 1);
                encodedCard.nameTag = `§a[RFID Kart: ${holderLabel}]`;
                
                // Teknik kimlikleri Dynamic Property içine gizliyoruz
                encodedCard.setDynamicProperty("rust_door_key", doorObj.key);
                encodedCard.setDynamicProperty("rust_card_id", cardId);

                // Lore'da sadece kullanıcı dostu yazılar kalıyor
                encodedCard.setLore([
                    `§7Yetkili: §e${holderLabel}`,
                    `§7Kapı: §f${doorName}`,
                    "§8Güvenlik: Kriptolu Çip"
                ]);

                const leftover = container.addItem(encodedCard);
                if (leftover) player.dimension.spawnItem(encodedCard, player.location);
                player.playSound("random.levelup", { pitch: 1.6, volume: 1.0 });
                player.onScreenDisplay.setActionBar(`§a[+] Kart Basıldı: §f${holderLabel} §a-> §e${doorName}`);
            } catch (e) {}

            system.run(() => openDoorManagementMenu(player, doorObj));
        }).catch(() => releasePlayer(player));
}

function openCardManagerMenu(player, doorKey, doorData, lowerBlock, doorObj = null) {
    const cards = doorData.cards || [];
    const doorName = doorData.name || "Sığınak Kapısı";
    const form = new ActionFormData().title(`§1[KARTLAR: ${doorName}]§r`);

    if (cards.length === 0) form.body("§7Bu kapıya tanımlı aktif bir kart yok.");
    else {
        form.body(`§e${cards.length}§7 kart kayıtlı. Yetkisini iptal etmek istediğine tıkla:`);
        for (const c of cards) form.button(`§c[İPTAL ET] §0${c.h}\n§8Kapı: ${doorName}`, "textures/ui/cancel");
    }

    form.button("§8<< Geri Dön", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled || res.selection >= cards.length) { 
            if (doorObj) {
                system.run(() => openDoorManagementMenu(player, doorObj));
            } else if (lowerBlock) {
                system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
            } else {
                releasePlayer(player);
            }
            return; 
        }
        confirmDeleteCard(player, doorKey, doorData, lowerBlock, cards[res.selection], doorObj);
    }).catch(() => releasePlayer(player));
}

function confirmDeleteCard(player, doorKey, doorData, lowerBlock, targetCard, doorObj = null) {
    const doorName = doorData.name || "Kapı";
    new ActionFormData().title("§4[YETKİ İPTALİ]§r").body(`§e${targetCard.h}§7 adlı kartın §e${doorName}§7 kapısındaki erişim yetkisi silinsin mi?`)
        .button("§4Yetkiyi Sil", "textures/ui/cancel").button("§8Vazgeç", "textures/ui/cancel")
        .show(player).then((res) => {
            if (res.canceled || res.selection === 1) { 
                system.run(() => openCardManagerMenu(player, doorKey, doorData, lowerBlock, doorObj)); 
                return; 
            }
            doorData.cards = (doorData.cards || []).filter((c) => c.id !== targetCard.id);
            saveDoorData(doorKey, doorData, true);
            player.playSound("random.break", { pitch: 1.2, volume: 1.0 });
            if (doorObj) system.run(() => openCardManagerMenu(player, doorKey, doorData, lowerBlock, doorObj));
            else releasePlayer(player);
        }).catch(() => releasePlayer(player));
}

function openCoOwnerMenu(player, doorKey, doorData, lowerBlock) {
    const coOwners = doorData.coOwners || [];
    const form = new ActionFormData().title("§6[ORTAK YÖNETİCİ]§r");

    if (coOwners.length === 0) form.body("§7Ortak yönetici yok.");
    else {
        form.body(`§e${coOwners.length}§7 Ortak var. Yetkiyi almak için tıkla:`);
        for (const co of coOwners) form.button(`§c[AZLET] §0${co.name}`, "textures/ui/cancel");
    }

    form.button("§2[+] Yeni Co-Owner Ata", "textures/items/totem").button("§4[!] Liderliği Devret", "textures/items/paper").button("§8<< Geri Dön", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled) { releasePlayer(player); return; }
        if (coOwners.length === 0) {
            if (res.selection === 0) system.run(() => openAddCoOwnerModal(player, doorKey, doorData, lowerBlock));
            else if (res.selection === 1) system.run(() => openTransferOwnershipModal(player, doorKey, doorData, lowerBlock));
            else system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
        } else {
            if (res.selection < coOwners.length) {
                doorData.coOwners = doorData.coOwners.filter((c) => c.id !== coOwners[res.selection].id);
                saveDoorData(doorKey, doorData, true);
                player.playSound("random.break", { pitch: 1.2, volume: 1.0 });
                releasePlayer(player);
            } else if (res.selection === coOwners.length) system.run(() => openAddCoOwnerModal(player, doorKey, doorData, lowerBlock));
            else if (res.selection === coOwners.length + 1) system.run(() => openTransferOwnershipModal(player, doorKey, doorData, lowerBlock));
            else system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
        }
    }).catch(() => releasePlayer(player));
}

function openAddCoOwnerModal(player, doorKey, doorData, lowerBlock) {
    const existing = new Set((doorData.coOwners || []).map((c) => c.id)); existing.add(doorData.owner);
    const available = world.getAllPlayers().filter((p) => !existing.has(p.id));

    if (available.length === 0) { player.onScreenDisplay.setActionBar("§c[!] Başka oyuncu yok!"); releasePlayer(player); return; }

    const form = new ActionFormData().title("§2[CO-OWNER SEC]§r").body("§7Ortak yapmak istediğin kişiyi seç:");
    for (const p of available) form.button(`§2[ATA] §0${p.nameTag}`);
    form.button("§8İptal", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled || res.selection >= available.length) { system.run(() => openCoOwnerMenu(player, doorKey, doorData, lowerBlock)); return; }
        const sel = available[res.selection];
        if (!doorData.coOwners) doorData.coOwners = [];
        doorData.coOwners.push({ id: sel.id, name: sel.nameTag });
        saveDoorData(doorKey, doorData, true);
        player.playSound("random.levelup", { pitch: 1.6, volume: 1.0 });
        releasePlayer(player);
    }).catch(() => releasePlayer(player));
}

function openTransferOwnershipModal(player, doorKey, doorData, lowerBlock) {
    const available = world.getAllPlayers().filter((p) => p.id !== player.id);
    if (available.length === 0) { player.onScreenDisplay.setActionBar("§c[!] Devredilecek kimse yok!"); releasePlayer(player); return; }

    const form = new ActionFormData().title("§4[LİDERLİĞİ DEVRET]§r").body("§cDIKKAT! Bu işlem geri alınamaz!");
    for (const p of available) form.button(`§4[DEVRET] §0${p.nameTag}`);
    form.button("§8İptal", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled || res.selection >= available.length) { system.run(() => openCoOwnerMenu(player, doorKey, doorData, lowerBlock)); return; }
        const newOwner = available[res.selection];
        doorData.owner = newOwner.id;
        doorData.coOwners = (doorData.coOwners || []).filter((c) => c.id !== newOwner.id);
        saveDoorData(doorKey, doorData, true);
        player.playSound("random.break", { pitch: 1.0, volume: 1.0 });
        releasePlayer(player);
    }).catch(() => releasePlayer(player));
}

function openWhitelistMenu(player, doorKey, doorData, lowerBlock) {
    const whitelist = doorData.whitelist || [];
    const form = new ActionFormData().title("§1[KLAN PANELİ]§r");

    if (whitelist.length === 0) form.body("§7Yetkili klan üyesi yok.");
    else {
        form.body(`§a${whitelist.length}§7 oyuncu var. Çıkarmak için tıkla:`);
        for (const m of whitelist) form.button(`§c[ÇIKAR] §0${m.name}`, "textures/ui/cancel");
    }

    form.button("§2[+] Oyuncu Yetkilendir", "textures/items/paper").button("§8<< Geri Dön", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled) { releasePlayer(player); return; }
        if (whitelist.length === 0) {
            if (res.selection === 0) system.run(() => openAddMemberModal(player, doorKey, doorData, lowerBlock));
            else system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
        } else {
            if (res.selection < whitelist.length) {
                doorData.whitelist = doorData.whitelist.filter((m) => m.id !== whitelist[res.selection].id);
                saveDoorData(doorKey, doorData, true);
                player.playSound("random.break", { pitch: 1.2, volume: 1.0 });
                releasePlayer(player);
            } else if (res.selection === whitelist.length) system.run(() => openAddMemberModal(player, doorKey, doorData, lowerBlock));
            else system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
        }
    }).catch(() => releasePlayer(player));
}

function openAddMemberModal(player, doorKey, doorData, lowerBlock) {
    const whitelistedIds = new Set((doorData.whitelist || []).map((m) => m.id));
    const available = world.getAllPlayers().filter((p) => p.id !== player.id && !whitelistedIds.has(p.id));

    if (available.length === 0) { player.onScreenDisplay.setActionBar("§c[!] Oyuncu yok!"); releasePlayer(player); return; }

    const form = new ActionFormData().title("§2[OYUNCU SEÇ]§r").body("§7Yetki verilecek oyuncuyu seç:");
    for (const p of available) form.button(`§2[EKLE] §0${p.nameTag}`);
    form.button("§8İptal", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled || res.selection >= available.length) { system.run(() => openWhitelistMenu(player, doorKey, doorData, lowerBlock)); return; }
        const sel = available[res.selection];
        authorizePlayer(doorData, sel.id, sel.nameTag);
        saveDoorData(doorKey, doorData, true);
        player.playSound("random.levelup", { pitch: 1.5, volume: 1.0 });
        releasePlayer(player);
    }).catch(() => releasePlayer(player));
}

function openTimerModal(player, doorKey, doorData, lowerBlock) {
    new ModalFormData().title("§8[KAPI ZAMANLAYICISI]§r").slider("Kapı Açık Kalma Süresi (sn):", 2, 10, 1, doorData.timer ?? DEFAULT_DOOR_TIMER)
        .show(player).then((res) => {
            releasePlayer(player);
            if (res.canceled) return;
            doorData.timer = Math.round(res.formValues[0]);
            saveDoorData(doorKey, doorData, true);
            player.playSound("random.levelup", { pitch: 1.4, volume: 1.0 });
        }).catch(() => releasePlayer(player));
}

function openRenameDoorModal(player, doorKey, doorData, lowerBlock) {
    new ModalFormData().title("§8[KAPI İSMİNİ DEĞİŞTİR]§r")
        .textField("Yeni Kapı İsmi Belirle:", "Örn: Ana Giriş Kapısı", doorData.name || "")
        .show(player).then((res) => {
            releasePlayer(player);
            if (res.canceled) return;
            const newName = (res.formValues[0] || "").trim();
            if (newName.length > 0) {
                doorData.name = newName;
                saveDoorData(doorKey, doorData, true);
                player.playSound("random.levelup", { pitch: 1.5, volume: 1.0 });
                player.onScreenDisplay.setActionBar(`§a[+] Kapı İsmi Güncellendi: §e${newName}`);
            }
        }).catch(() => releasePlayer(player));
}

// -------------------------------------------------------------
// EVENT VE ETKİLEŞİM DÖNGÜSÜ
// -------------------------------------------------------------
world.beforeEvents.itemUseOn.subscribe((event) => {
    const { itemStack, player, block } = event;
    if (itemStack && (itemStack.typeId === "minecraft:flint_and_steel" || itemStack.typeId === "minecraft:fire_charge")) {
        const protectedDoor = findNearbyProtectedDoor(block.dimension, block.location, 5);
        if (protectedDoor && protectedDoor.data && !isPlayerAuthorized(protectedDoor.data, player.id)) {
            event.cancel = true;
            system.run(() => {
                player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
                player.onScreenDisplay.setActionBar("§c[!] BU ALAN KORUMALI! Ateş yakamazsın.");
            });
        }
    }
});

// -------------------------------------------------------------
// PATLAMA KORUMASI: KUSURSUZ VE YEDEĞE UYGUN ÇÖZÜM
// -------------------------------------------------------------
world.beforeEvents.explosion.subscribe((event) => {
    const dim = event.dimension;
    const blocks = event.getImpactedBlocks();
    if (!blocks || blocks.length === 0) return;

    // Aktif koruma alanına sahip kapıların listesini al
    const protectedDoors = [];
    for (const [key, cache] of doorCache.entries()) {
        if (cache.dim === dim.id && cache.data) {
            protectedDoors.push({
                x: cache.x,
                y: cache.y,
                z: cache.z,
                area: cache.data.areaProtection === true
            });
        }
    }

    const safeBlocks = [];

    for (const b of blocks) {
        // 1. Kural: Sığınak kapısının hiçbir parçası ASLA patlayamaz
        if (isAnyBunkerDoor(b.typeId)) {
            continue; // Listeye alma (patlamasın)
        }

        // 2. Kural: Kapının hemen altındaki zemin bloğu patlayamaz (kapı düşmesin diye)
        try {
            const above = dim.getBlock({ x: b.x, y: b.y + 1, z: b.z });
            if (above && isAnyBunkerDoor(above.typeId)) {
                continue;
            }
        } catch (e) {}

        // 3. Kural: Alan koruması aktif olan kapıların 5 blok çevresi patlayamaz
        let inProtectedZone = false;
        for (const door of protectedDoors) {
            if (door.area) {
                const dx = Math.abs(b.x - door.x);
                const dy = Math.abs(b.y - door.y);
                const dz = Math.abs(b.z - door.z);
                if (dx <= 5 && dy <= 5 && dz <= 5) {
                    inProtectedZone = true;
                    break;
                }
            }
        }

        if (!inProtectedZone) {
            safeBlocks.push(b);
        }
    }

    event.setImpactedBlocks(safeBlocks);
});

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const { block, player } = event;

    // Tezgah Etkileşimi
    if (block.typeId === WORKBENCH_ID) {
        if (player.isSneaking) {
            event.cancel = true;
            if (activeSessions.has(player.id)) return;
            activeSessions.add(player.id);
            system.run(() => { openAllDoorsAndCardsMenu(player); });
            return;
        }
        return;
    }

    // Kapı Etkileşimi
    if (block.typeId.startsWith("rust:bunker_door")) {
        event.cancel = true;
        if (activeSessions.has(player.id)) return;
        activeSessions.add(player.id);
        system.run(() => { handleDoorInteraction(player, block); });
        return;
    }

    if (isRedstoneComponent(block.typeId)) {
        const nearby = findNearbyLockedDoor(block.dimension, block.location, 2);
        if (nearby && nearby.data.owner && nearby.data.owner !== player.id) {
            event.cancel = true;
            system.run(() => { triggerRedstoneShock(player, block, nearby.lowerBlock, nearby.data.owner); });
        }
    }
});

world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const { block } = event;

    if (isBaseDoor(block.typeId)) {
        const dimension = block.dimension;
        const pos = block.location;

        function getCardinalDirection(targetBlock) { try { return targetBlock.permutation.getState("minecraft:cardinal_direction"); } catch(e){return null;} }
        function getRightVector(facing) {
            switch (facing) { case "north": return { x:1,z:0 }; case "east": return { x:0,z:1 }; case "south": return { x:-1,z:0 }; case "west": return { x:0,z:-1 }; default: return { x:1,z:0 }; }
        }
        function getLeftVector(facing) { const right = getRightVector(facing); return { x:-right.x, z:-right.z }; }
        function getNeighbor(offsetX, offsetZ) { try { return dimension.getBlock({ x: pos.x+offsetX, y: pos.y, z: pos.z+offsetZ }); } catch(e){return null;} }
        function setReversed(targetBlock, reversed) { try { targetBlock.setPermutation(targetBlock.permutation.withState("rust:reversed", reversed)); } catch(e){} }

        const facing = getCardinalDirection(block);
        let currentReversed = false;

        const right = getRightVector(facing);
        const left = getLeftVector(facing);

        const rightNeighbor = getNeighbor(right.x, right.z);
        const leftNeighbor = getNeighbor(left.x, left.z);

        let connectedDoor = null;
        let isPlacedOnRight = false;

        if (leftNeighbor && leftNeighbor.typeId === block.typeId) { connectedDoor = leftNeighbor; isPlacedOnRight = true; } 
        else if (rightNeighbor && rightNeighbor.typeId === block.typeId) { connectedDoor = rightNeighbor; isPlacedOnRight = false; }

        if (connectedDoor) currentReversed = isPlacedOnRight;
        setReversed(block, currentReversed);

        const topBlock = block.above();
        if (topBlock && topBlock.isAir) {
            const topBlockTypeId = block.typeId + "_top";
            topBlock.setType(topBlockTypeId);
            try {
                let topPermutation = topBlock.permutation;
                if (facing) topPermutation = topPermutation.withState("minecraft:cardinal_direction", facing);
                topPermutation = topPermutation.withState("rust:reversed", currentReversed);
                topBlock.setPermutation(topPermutation);
            } catch (e) {}
        }

        if (connectedDoor) {
            try {
                const neighborTop = connectedDoor.above();
                if (neighborTop && isTopDoor(neighborTop.typeId)) {
                    const neighborFacing = getCardinalDirection(connectedDoor);
                    let neighborTopPermutation = neighborTop.permutation;
                    if (neighborFacing) neighborTopPermutation = neighborTopPermutation.withState("minecraft:cardinal_direction", neighborFacing);
                    let neighborReversed = false;
                    try { neighborReversed = connectedDoor.permutation.getState("rust:reversed"); } catch (e) {}
                    neighborTopPermutation = neighborTopPermutation.withState("rust:reversed", neighborReversed);
                    neighborTop.setPermutation(neighborTopPermutation);
                }
            } catch (e) {}
        }
    }

    if (isRedstoneComponent(block.typeId)) {
        const nearby = findNearbyLockedDoor(block.dimension, block.location, 2);
        if (nearby && nearby.data.owner && nearby.data.owner !== player.id) triggerRedstoneShock(player, block, nearby.lowerBlock, nearby.data.owner);
    }
});

world.beforeEvents.playerBreakBlock.subscribe((event) => {
    const { block, player } = event;

    if (block.typeId.startsWith("rust:bunker_door")) {
        const { lowerBlock } = getDoorBlocks(block);
        if (!lowerBlock) return;

        const { data } = getDoorData(lowerBlock);
        if (!data || !data.pin) return;

        event.cancel = true;
        system.run(() => {
            if (data.owner && data.owner !== player.id) {
                player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
                player.onScreenDisplay.setActionBar("§c[!] Kapı kilitli! Yalnızca sahibi kırabilir.");
                notifyOwner(data.owner, `§4§l[BASKIN ALARMI] §c${player.nameTag} kapını kırıyor!\n§eKonum: §fX:${lowerBlock.x}, Y:${lowerBlock.y}, Z:${lowerBlock.z}`, "§4§lKAPI ZORLANIYOR!", `§c${player.nameTag} kapını kazıyor!`);
            }
        });
        return;
    }

    try {
        const blockAbove = block.dimension.getBlock({ x: block.x, y: block.y + 1, z: block.z });
        if (blockAbove && isBaseDoor(blockAbove.typeId)) {
            const { data } = getDoorData(blockAbove);
            if (data && data.pin && data.owner && data.owner !== player.id) {
                event.cancel = true;
                system.run(() => {
                    player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
                    player.onScreenDisplay.setActionBar("§c[!] Üzerinde kilitli kapı var! Zemini kıramazsın.");
                });
                return;
            }
        }
    } catch (e) {}

    // Alan koruması kontrolü
    for (const [key, cache] of doorCache.entries()) {
        if (cache.dim === block.dimension.id && cache.data && cache.data.areaProtection) {
            const dx = Math.abs(block.x - cache.x);
            const dy = Math.abs(block.y - cache.y);
            const dz = Math.abs(block.z - cache.z);
            if (dx <= 5 && dy <= 5 && dz <= 5) {
                if (!isPlayerAuthorized(cache.data, player.id)) {
                    event.cancel = true;
                    system.run(() => {
                        player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
                        player.onScreenDisplay.setActionBar("§c[!] BU ALAN KAPI TARAFINDAN KORUNUYOR!");
                        notifyOwner(cache.data.owner, `§4§l[ALAN ALARMI] §c${player.nameTag} 5 blokluk koruma alanını kazıyor!`, "§4§lALAN İHLALİ!", `§c${player.nameTag} duvarlarını kırıyor!`);
                    });
                    return;
                }
            }
        }
    }
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
    const { block, brokenBlockPermutation } = event;
    const brokenId = brokenBlockPermutation.type.id;

    if (isBaseDoor(brokenId)) {
        const topBlock = block.above();
        const expectedTopId = brokenId + "_top";
        if (topBlock && topBlock.typeId === expectedTopId) topBlock.setType("minecraft:air");
    } else if (isTopDoor(brokenId)) {
        const bottomBlock = block.below();
        const expectedBaseId = brokenId.replace("_top", "");
        if (bottomBlock && bottomBlock.typeId === expectedBaseId) bottomBlock.setType("minecraft:air");
    }
});

function handleDoorInteraction(player, clickedBlock) {
    const { lowerBlock, upperBlock, isUpper } = getDoorBlocks(clickedBlock);
    if (!lowerBlock) { releasePlayer(player); return; }

    const { key, data } = getDoorData(lowerBlock);

    if (!data || !data.pin) { openSetupMenu(player, key, lowerBlock); return; }

    if (player.isSneaking && isPlayerManager(data, player.id)) { openOwnerMenu(player, key, data, lowerBlock); return; }

    const isAuth = isPlayerAuthorized(data, player.id);
    const inside = isPlayerInside(player, lowerBlock, data);

    if (inside && isAuth && isUpper) { startSpyCam(player, lowerBlock, data); releasePlayer(player); return; }

    if (isAuth) {
        player.playSound("random.orb", { pitch: 1.5, volume: 0.8 });
        player.onScreenDisplay.setActionBar(inside ? "§a[>] ÇIKIŞ YAPILDI §8| §7Kapı Açıldı" : "§a[>] YETKİLİ GİRİŞİ §8| §7Kapı Açıldı");
        spawnDoorLaserScan(lowerBlock.dimension, lowerBlock, true);
        toggleDoor(lowerBlock, upperBlock, data);
        releasePlayer(player); return;
    }

    const heldCard = findHeldItem(player, KEYCARD_ID)?.item;
    if (heldCard) {
        let cardDoorToken = heldCard.getDynamicProperty("rust_door_key");
        let cardId = heldCard.getDynamicProperty("rust_card_id");

        if (!cardDoorToken) {
            const lore = heldCard.getLore() || [];
            const doorLine = lore.find(l => l.startsWith("§8DOOR:"));
            const cidLine = lore.find(l => l.startsWith("§8CID:"));
            if (doorLine) cardDoorToken = doorLine.replace("§8DOOR:", "");
            if (cidLine) cardId = cidLine.replace("§8CID:", "");
        }

        if (cardDoorToken && cardDoorToken === key) {
            if ((data.cards || []).some((c) => c.id === cardId)) {
                player.playSound("random.levelup", { pitch: 1.8, volume: 0.8 });
                player.onScreenDisplay.setActionBar("§a[RFID] KART ONAYLANDI §8| §7Erişim Açıldı");
                spawnDoorLaserScan(lowerBlock.dimension, lowerBlock, true);
                toggleDoor(lowerBlock, upperBlock, data);
            } else {
                player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
                player.onScreenDisplay.setActionBar("§c[!] KART GEÇERSİZ! Yetkisi silinmiş.");
            }
        } else {
            player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
            player.onScreenDisplay.setActionBar("§c[!] Geçersiz Kart! Bu kapıya ait değil.");
        }
        releasePlayer(player); return;
    }

    const userLockKey = `${key}_${player.id}`;
    const lockedUntil = shockCooldowns.get(userLockKey) || 0;
    const now = Date.now();

    if (now < lockedUntil) {
        const remainingSec = Math.ceil((lockedUntil - now) / 1000);
        player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
        player.onScreenDisplay.setActionBar(`§c[!] SİSTEM KİLİTLİ! Ceza: §e${remainingSec} sn`);
        releasePlayer(player); return;
    }

    openKeypadModal(player, lowerBlock, upperBlock, key, data);
}

function openSetupMenu(player, doorKey, lowerBlock) {
    player.playSound("random.click", { pitch: 1.2, volume: 0.6 });

    new ModalFormData().title("§2[KEYPAD KURULUMU]§r")
        .textField("Yeni 4 Haneli PIN Belirle:", "Örn: 1234")
        .textField("Bu Kapıya Bir İsim Ver:", "Örn: Ana Giriş Kapısı", `Kapı [${lowerBlock.x}, ${lowerBlock.y}, ${lowerBlock.z}]`)
        .show(player).then((res) => {
            releasePlayer(player);
            if (res.canceled) return;

            const cleanPin = (res.formValues[0] || "").trim();
            const doorName = (res.formValues[1] || "").trim() || `Kapı [${lowerBlock.x}, ${lowerBlock.y}, ${lowerBlock.z}]`;

            if (cleanPin.length > 0) {
                const newDoorData = {
                    pin: cleanPin, name: doorName, owner: player.id, hp: MAX_DOOR_HP, timer: DEFAULT_DOOR_TIMER,
                    antiPinch: false, areaProtection: false, coOwners: [], whitelist: [{ id: player.id, name: player.nameTag }], cards: []
                };

                saveOutsideDirection(newDoorData, lowerBlock, player.location);
                saveDoorData(doorKey, newDoorData, true);
                player.playSound("random.levelup", { pitch: 1.4, volume: 0.8 });
                player.onScreenDisplay.setActionBar(`§a[+] Kilit Kuruldu: §e${doorName}`);
            }
        }).catch(() => releasePlayer(player));
}

function openKeypadModal(player, lowerBlock, upperBlock, doorKey, doorData) {
    player.playSound("note.pling", { pitch: 2.0, volume: 0.6 });

    new ModalFormData().title("§4[KİLİTLİ KAPI]§r").textField("Giriş için 4 haneli PIN yazın:", "****")
        .show(player).then((res) => {
            releasePlayer(player);
            if (res.canceled) return;

            const cleanPin = (res.formValues[0] || "").trim();
            const userLockKey = `${doorKey}_${player.id}`;

            if (cleanPin === doorData.pin) {
                failedAttempts.delete(userLockKey);
                shockCooldowns.delete(userLockKey);
                player.playSound("random.orb", { pitch: 1.8, volume: 0.9 });
                player.onScreenDisplay.setActionBar("§a[>] PIN DOĞRULANDI §8| §7Kapı Açıldı");
                spawnDoorLaserScan(lowerBlock.dimension, lowerBlock, true);
                toggleDoor(lowerBlock, upperBlock, doorData);
            } else {
                const currentFails = (failedAttempts.get(userLockKey) || 0) + 1;
                spawnDoorLaserScan(lowerBlock.dimension, lowerBlock, false);

                if (currentFails >= 2) {
                    failedAttempts.delete(userLockKey);
                    shockCooldowns.set(userLockKey, Date.now() + 15000);
                    player.applyDamage(6);
                    player.playSound("ambient.weather.thunder", { pitch: 1.8, volume: 1.0 });
                    try { player.dimension.spawnParticle("minecraft:electric_spark_particle", { x: player.location.x, y: player.location.y + 1, z: player.location.z }); } catch (e) {}
                    player.onScreenDisplay.setActionBar("§c[!] ELEKTROŞOK! 2 Hatalı Deneme §8| §e15s Ceza");
                    if (doorData.owner && doorData.owner !== player.id) notifyOwner(doorData.owner, `§4§l[BASKIN ALARMI] §c${player.nameTag} kapını zorladı ve şok yedi!`, "§4§lBASKIN ALARMI!", `§c${player.nameTag} kapında şoklandı!`);
                } else {
                    failedAttempts.set(userLockKey, currentFails);
                    player.playSound("note.bass", { pitch: 0.5, volume: 1.0 });
                    player.onScreenDisplay.setActionBar("§c[!] Hatalı PIN! (§e1/2§c) §8| §4Tekrar denersen şok yersin!");
                }
            }
        }).catch(() => releasePlayer(player));
}

function openOwnerMenu(player, doorKey, doorData, lowerBlock) {
    player.playSound("random.click", { pitch: 1.5, volume: 0.6 });

    const currentSec = doorData.timer ?? DEFAULT_DOOR_TIMER;
    const isOwner = isPlayerOwner(doorData, player.id);
    const doorName = doorData.name || `Kapı [${lowerBlock.x}, ${lowerBlock.y}, ${lowerBlock.z}]`;

    const form = new ActionFormData()
        .title(`§8[${doorName}]§r`)
        .body(`§7Yetki: ${isOwner ? "§6Asıl Lider" : "§bOrtak Yönetici"}\n§7Kapı İsmi: §e${doorName}`);

    if (isOwner) form.button("[KLAN] Co-Owner Yönetimi", "textures/items/totem");

    form.button("[İSİM] Kapı İsmini Değiştir", "textures/items/name_tag")
        .button("Klan / Whitelist Paneli", "textures/items/paper")
        .button(`Açık Kalma Süresi (${currentSec}s)`, "textures/items/clock_item")
        .button(`Lazer Engel Sensörü: ${doorData.antiPinch ? "§a[AKTİF]" : "§c[PASİF]"}`, "textures/items/shears")
        .button(`Alan Koruması (5 Blok): ${doorData.areaProtection ? "§a[AKTİF]" : "§c[PASİF]"}`, "textures/items/diamond_chestplate")
        .button("[YÖN] Dış/İç Yönünü Ters Çevir", "textures/items/compass_item")
        .button("PIN Kodunu Değiştir", "textures/items/paper")
        .button("[REHBER] Mod Rehberi", "textures/items/book_writable");

    if (isOwner) form.button("Kilidi Sök (Sıfırlayıp Kır)", "textures/items/iron_pickaxe");
    form.button("İptal", "textures/ui/cancel");

    form.show(player).then((res) => {
        if (res.canceled) { releasePlayer(player); return; }
        let sel = res.selection;
        if (isOwner) { if (sel === 0) { system.run(() => openCoOwnerMenu(player, doorKey, doorData, lowerBlock)); return; } sel -= 1; }

        if (sel === 0) system.run(() => openRenameDoorModal(player, doorKey, doorData, lowerBlock));
        else if (sel === 1) system.run(() => openWhitelistMenu(player, doorKey, doorData, lowerBlock));
        else if (sel === 2) system.run(() => openTimerModal(player, doorKey, doorData, lowerBlock));
        else if (sel === 3) {
            doorData.antiPinch = !doorData.antiPinch; saveDoorData(doorKey, doorData, true);
            player.playSound("random.click", { pitch: doorData.antiPinch ? 1.6 : 0.8, volume: 1.0 });
            player.onScreenDisplay.setActionBar(doorData.antiPinch ? "§a[+] Sensör AKTİF" : "§c[-] Sensör PASİF");
            system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
        } else if (sel === 4) {
            doorData.areaProtection = !doorData.areaProtection; saveDoorData(doorKey, doorData, true);
            player.playSound("random.click", { pitch: doorData.areaProtection ? 1.6 : 0.8, volume: 1.0 });
            player.onScreenDisplay.setActionBar(doorData.areaProtection ? "§a[+] 5 Blokluk Alan Koruması AKTİF" : "§c[-] Alan Koruması PASİF");
            system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
        } else if (sel === 5) {
            const [axis, signStr] = (doorData.dir || "z:1").split(":");
            doorData.dir = `${axis}:${-parseFloat(signStr)}`;
            saveDoorData(doorKey, doorData, true);
            player.playSound("random.levelup", { pitch: 1.5, volume: 1.0 });
            system.run(() => openOwnerMenu(player, doorKey, doorData, lowerBlock));
        } else if (sel === 6) system.run(() => openSetupMenu(player, doorKey, lowerBlock));
        else if (sel === 7) openHelpGuide(player);
        else if (isOwner && sel === 8) {
            saveDoorData(doorKey, null, true);
            player.playSound("random.break", { pitch: 1.0, volume: 1.0 });
            player.onScreenDisplay.setActionBar("§e[!] Kilit kapıdan tamamen söküldü.");
            releasePlayer(player);
        } else releasePlayer(player);
    }).catch(() => releasePlayer(player));
}

function playSmartSound(dimension, location, customSound, fallbackSound, pitch = 1.0, volume = 1.0) {
    try { dimension.playSound(customSound, location, { pitch, volume }); } catch (e) {
        try { dimension.playSound(fallbackSound, location, { pitch, volume }); } catch (err) {}
    }
}

function toggleDoor(lowerBlock, upperBlock, doorData) {
    const doors = [{ lower: lowerBlock, upper: upperBlock }];
    const adjacent = findAdjacentDoor(lowerBlock);
    if (adjacent && adjacent.lowerBlock && adjacent.upperBlock) doors.push({ lower: adjacent.lowerBlock, upper: adjacent.upperBlock });

    playSmartSound(lowerBlock.dimension, lowerBlock.location, CUSTOM_SOUND_OPEN, "tile.piston.out", 0.85, 1.0);
    try { lowerBlock.dimension.playSound("random.fizz", lowerBlock.location, { pitch: 1.4, volume: 0.5 }); } catch (e) {}

    for (const d of doors) {
        try {
            d.lower.setPermutation(d.lower.permutation.withState("rust:open", true));
            if (d.upper && isTopDoor(d.upper.typeId)) d.upper.setPermutation(d.upper.permutation.withState("rust:open", true));
        } catch (e) {}
    }

    const totalTicks = (doorData.timer ?? DEFAULT_DOOR_TIMER) * 20;

    if (totalTicks > 20) system.runTimeout(() => { try { lowerBlock.dimension.playSound("note.pling", lowerBlock.location, { pitch: 1.5, volume: 0.7 }); } catch (e) {} }, totalTicks - 20);
    if (totalTicks > 10) system.runTimeout(() => { try { lowerBlock.dimension.playSound("note.pling", lowerBlock.location, { pitch: 2.0, volume: 0.9 }); } catch (e) {} }, totalTicks - 10);

    function attemptClose() {
        if (doorData.antiPinch && isDoorwayBlocked(lowerBlock.dimension, lowerBlock, adjacent?.lowerBlock)) {
            try { lowerBlock.dimension.playSound("random.click", lowerBlock.location, { pitch: 1.8, volume: 0.8 }); } catch (e) {}
            system.runTimeout(attemptClose, 20); return;
        }

        let soundPlayed = false;
        for (const d of doors) {
            try {
                if (d.lower.permutation.getState("rust:open")) {
                    d.lower.setPermutation(d.lower.permutation.withState("rust:open", false));
                    if (d.upper && isTopDoor(d.upper.typeId)) d.upper.setPermutation(d.upper.permutation.withState("rust:open", false));
                    if (!soundPlayed) { playSmartSound(d.lower.dimension, d.lower.location, CUSTOM_SOUND_CLOSE, "random.door_close", 0.7, 1.0); soundPlayed = true; }
                }
            } catch (e) {}
        }
    }
    system.runTimeout(attemptClose, totalTicks);
}

world.afterEvents.playerSpawn.subscribe((event) => {
    const { player, initialSpawn } = event;
    if (initialSpawn) {
        system.runTimeout(() => {
            if (!player.getDynamicProperty("rust_has_book")) {
                player.setDynamicProperty("rust_has_book", true);
                const book = new ItemStack("minecraft:book", 1);
                book.nameTag = "§6§l[Rust Bunker Doors] §eRehber Kitabı";
                book.setLore(["§7Elindeyken sağ tıkla,", "§7tüm kapı rehberini anında aç!", "§8Geliştirici: Ömer Fatih"]);
                const inv = player.getComponent("minecraft:inventory")?.container;
                if (inv) if (inv.addItem(book)) player.dimension.spawnItem(book, player.location);
                player.playSound("random.levelup", { pitch: 1.2, volume: 1.0 });
                player.sendMessage("§8§m----------------------------------------\n§6§l[RUST BUNKER DOORS] §aGüvenlik Sistemi Aktif!\n§7Geliştirici: §eÖmer Fatih\n§eEnvanterine Rehber Kitabı verildi! Sağ tıklayarak kullanabilirsin.\n§8§m----------------------------------------");
            }
        }, 40);
    }
});

world.afterEvents.itemUse.subscribe((event) => {
    const { itemStack, source } = event;
    if (source.typeId === "minecraft:player" && itemStack?.typeId === "minecraft:book" && itemStack.nameTag?.includes("Rust Bunker Doors")) {
        system.run(() => { openHelpGuide(source); });
    }
});

function openHelpGuide(player) {
    player.playSound("random.click", { pitch: 1.5, volume: 0.8 });
    new ActionFormData().title("§6[RUST DOOR REHBERİ]§r")
        .body("§7Geliştirici: §eÖmer Fatih\n§fBilgi almak istediğin güvenlik protokolünü seç:")
        .button("[PIN] Kurulum & Ayarlar", "textures/items/paper").button("[KART] RFID & Maliyet", "textures/items/keycard")
        .button("[KLAN] Lider & Co-Owner", "textures/items/totem").button("[MAZGAL] Kamera & Sensör", "textures/items/shears")
        .button("[SABOTAJ] Alan Koruması & Redstone", "textures/items/diamond_chestplate").button("Kapat", "textures/ui/cancel")
        .show(player).then((res) => {
            if (res.canceled || res.selection === 5) return;
            const infoForm = new ActionFormData();
            if (res.selection === 0) infoForm.title("§2[PIN & KURULUM]§r").body("§e- Kurulum:§7 Kilitsiz kapıya tıklayın, PIN ve İsim verin.\n§e- Çift Kapı:§7 Aynı isim ve ayarlar yan kapıya da otomatik işlenir.");
            else if (res.selection === 1) infoForm.title("§2[RFID KARTLAR]§r").body("§e- Üretim:§7 Tezgâhta (Workbench) 3x3 alanda boş kart yapın.\n§e- Kodlama:§7 Tezgâha eğilip tıklayarak kapıyı seçin ve kart basın.");
            else if (res.selection === 2) infoForm.title("§2[KLAN & CO-OWNER]§r").body("§e- Owner:§7 Kilidi kuran asıl lider.\n§e- Co-Owner:§7 Kapı ayarlarını yönetebilen ortak.\n§e- Whitelist:§7 Şifresiz açan klan üyeleri.");
            else if (res.selection === 3) infoForm.title("§2[MAZGAL & SENSÖR]§r").body("§e- Mazgal:§7 İçerideyken üst bloğa tıkla. Hareket (WASD) kapatır.\n§e- Sensör:§7 Eşikte biri varsa kapanmayı geciktirir.");
            else if (res.selection === 4) infoForm.title("§2[ALAN & SABOTAJ]§r").body("§e- 5 Blok Koruması:§7 Kazılamaz, çakmak çakılamaz, patlamalar önlenir.\n§e- Redstone Sabotajı:§7 Kapıya şalter bağlayan yabancıya şok basılır.");
            infoForm.button("<< Geri Dön", "textures/ui/cancel").show(player).then(() => system.run(() => openHelpGuide(player)));
        }).catch(() => {});
}