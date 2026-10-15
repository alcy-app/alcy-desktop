//! A tonic codec for messages known only at runtime.

use prost::Message;
use prost_reflect::{DynamicMessage, MessageDescriptor};
use tonic::Status;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};

/// Encodes any [`DynamicMessage`] and decodes messages of one type: the
/// method's output on a client, its input on a server.
#[derive(Debug, Clone)]
pub struct DynamicCodec {
    decode_as: MessageDescriptor,
}

impl DynamicCodec {
    pub fn new(decode_as: MessageDescriptor) -> Self {
        Self { decode_as }
    }
}

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder(self.decode_as.clone())
    }
}

#[derive(Debug)]
pub struct DynamicEncoder;

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        item.encode(dst)
            .map_err(|error| Status::internal(format!("falha ao codificar a mensagem: {error}")))
    }
}

#[derive(Debug)]
pub struct DynamicDecoder(MessageDescriptor);

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        DynamicMessage::decode(self.0.clone(), src)
            .map(Some)
            .map_err(|error| Status::internal(format!("falha ao decodificar a mensagem: {error}")))
    }
}
