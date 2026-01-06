import crypto from "node:crypto";
import assert from "node:assert";

export function CreateNewNodePrivateKey() {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const privateKeyPEM = privateKey.export({ type: "pkcs8", format: "pem" });
    assert(typeof privateKeyPEM === "string");
    return privateKeyPEM;
}

export class PrivateKeyWrapper {
    private keyObject: crypto.KeyObject;
    private derHash: string;
    private publicKeyPEM: string;

    constructor(privateKeyPEM: string) {
        this.keyObject = crypto.createPrivateKey({
            key: privateKeyPEM,
            format: "pem",
            encoding: "utf-8",
        });
        assert(this.keyObject.type === "private");
        assert(this.keyObject.asymmetricKeyType === "ed25519");

        const publicKey = crypto.createPublicKey({
            key: privateKeyPEM,
            format: "pem",
            encoding: "utf-8",
        });
        assert(publicKey.type === "public");
        assert(publicKey.asymmetricKeyType === "ed25519");

        this.derHash = crypto
            .createHash("sha256")
            .update(publicKey.export({ type: "spki", format: "der" }))
            .digest("hex");

        const publicKeyPEM = publicKey.export({
            type: "spki",
            format: "pem",
        });
        assert(
            typeof publicKeyPEM === "string",
            "Public key PEM should be a string"
        );
        this.publicKeyPEM = publicKeyPEM;
    }

    getKeyHash() {
        return this.derHash;
    }

    getPublicKeyPEM() {
        return this.publicKeyPEM;
    }

    sign(data: Buffer) {
        return crypto.sign(null, data, this.keyObject);
    }
}
