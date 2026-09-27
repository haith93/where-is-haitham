"""
Generate a VAPID key pair for Web Push.

    python tools/generate-vapid-keys.py

VAPID is just an ECDSA P-256 key pair in a particular encoding:
  * public  = the uncompressed point (0x04 || X || Y), 65 bytes, base64url
  * private = the raw private scalar, 32 bytes, base64url

Both halves are printed once and never written to disk, so nothing secret
ends up in the repository. The private key goes to Supabase only.

Requires the `cryptography` package, which is already installed here.
"""
import base64

from cryptography.hazmat.primitives.asymmetric import ec


def b64url(raw: bytes) -> str:
    """base64url with the padding stripped, which is what Web Push expects."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def main() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_numbers = private_key.public_key().public_numbers()

    # Uncompressed point: a 0x04 marker followed by the two 32-byte coordinates.
    public_raw = (
        b"\x04"
        + public_numbers.x.to_bytes(32, "big")
        + public_numbers.y.to_bytes(32, "big")
    )
    private_raw = private_key.private_numbers().private_value.to_bytes(32, "big")

    print()
    print("VAPID key pair")
    print("=" * 68)
    print()
    print("PUBLIC KEY  - safe to publish. Add as the GitHub repository secret")
    print("              VAPID_PUBLIC_KEY")
    print()
    print(f"  {b64url(public_raw)}")
    print()
    print("PRIVATE KEY - secret. Give it to Supabase only, never to GitHub,")
    print("              and never commit it.")
    print()
    print(f"  {b64url(private_raw)}")
    print()
    print("=" * 68)
    print("Keep this terminal open until both values are saved; they are not")
    print("stored anywhere and cannot be recovered afterwards.")
    print()


if __name__ == "__main__":
    main()
