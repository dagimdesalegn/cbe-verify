# cbe-verify (Python SDK)

Official Python SDK for the Ethiopian Payment Verification API.

## Install

    pip install cbe-verify

## Usage

    from cbe_verify import CbeVerifyClient

    client = CbeVerifyClient(api_key="cbe_verify_your_key", base_url="http://localhost:3000")

    result = client.verify(
        bank="cbe",
        reference_number="FT26262VQ6GV",
        account_suffix="35207333",
    )

    if result["data"][0]["verified"]:
        print("Confirmed:", result["data"][0]["amount"])

## License

MIT
