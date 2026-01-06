import crypto from "node:crypto";
import assert from "node:assert";

export class PrivateKeyWrapper {
    private keyObject: crypto.KeyObject;
    private derHash: string;

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
    }

    getKeyHash() {
        return this.derHash;
    }

    sign(data: Buffer) {
        return crypto.sign(null, data, this.keyObject);
    }
}
